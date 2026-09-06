"""Tests against an in-process x402 v2 resource: no chain, offline signing."""

from __future__ import annotations

import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from langchain_ausca import PayableCallError, payable_tool
from pydantic import BaseModel

BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
PRIVATE_KEY = "0x" + "7" * 64


class EchoInput(BaseModel):
    text: str


class _Resource(BaseHTTPRequestHandler):
    amount_atomic = "50000"
    seen: dict[str, int] = {}

    def log_message(self, *_args) -> None:  # noqa: N802
        pass

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length", 0))
        request_body = json.loads(self.rfile.read(length) or b"{}")
        if "PAYMENT-SIGNATURE" not in self.headers:
            type(self).seen["unsigned"] = type(self).seen.get("unsigned", 0) + 1
            challenge = {
                "x402Version": 2,
                "error": "PAYMENT-SIGNATURE header is required",
                "resource": {
                    "url": f"http://127.0.0.1:{self.server.server_port}{self.path}",
                    "description": "Test payable resource",
                    "mimeType": "application/json",
                    "serviceName": "Testkit",
                    "tags": ["test"],
                },
                "accepts": [
                    {
                        "scheme": "exact",
                        "network": "eip155:8453",
                        "asset": BASE_USDC,
                        "amount": type(self).amount_atomic,
                        "payTo": "0x1111111111111111111111111111111111111111",
                        "maxTimeoutSeconds": 60,
                        "extra": {"name": "USD Coin", "version": "2"},
                    }
                ],
            }
            body = json.dumps({"status": "error", "code": "payment_required"}).encode()
            self.send_response(402)
            self.send_header("content-type", "application/json")
            self.send_header(
                "PAYMENT-REQUIRED", base64.b64encode(json.dumps(challenge).encode()).decode()
            )
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        type(self).seen["signed"] = type(self).seen.get("signed", 0) + 1
        settle = {
            "success": True,
            "network": "eip155:8453",
            "transaction": "0x" + "ab" * 32,
            "payer": "0x2222222222222222222222222222222222222222",
        }
        body = json.dumps({"status": "ok", "echo": request_body}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header(
            "PAYMENT-RESPONSE", base64.b64encode(json.dumps(settle).encode()).decode()
        )
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture()
def resource():
    _Resource.seen = {}
    _Resource.amount_atomic = "50000"
    server = HTTPServer(("127.0.0.1", 0), _Resource)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}/paid"
    server.shutdown()


def test_tool_pays_within_cap_and_returns_settlement_proof(resource: str) -> None:
    receipts = []
    tool = payable_tool(
        name="echo",
        description="Calls the test payable resource.",
        args_schema=EchoInput,
        url=resource,
        private_key=PRIVATE_KEY,
        max_payment_usd=0.25,
        on_payment=receipts.append,
    )
    outcome = json.loads(tool.invoke({"text": "hello"}))
    assert outcome["result"]["status"] == "ok"
    assert outcome["result"]["echo"]["text"] == "hello"
    assert outcome["payment"]["success"] is True
    assert outcome["payment"]["transaction"].startswith("0x")
    assert len(receipts) == 1 and receipts[0].success
    assert _Resource.seen == {"unsigned": 1, "signed": 1}


def test_tool_refuses_to_pay_above_the_cap_before_signing(resource: str) -> None:
    _Resource.amount_atomic = "5000000"
    tool = payable_tool(
        name="echo",
        description="Calls the test payable resource.",
        args_schema=EchoInput,
        url=resource,
        private_key=PRIVATE_KEY,
        max_payment_usd=0.25,
    )
    with pytest.raises(Exception):
        tool.invoke({"text": "hello"})
    assert _Resource.seen.get("signed") is None


def test_build_body_maps_model_input(resource: str) -> None:
    tool = payable_tool(
        name="echo",
        description="Calls the test payable resource.",
        args_schema=EchoInput,
        url=resource,
        private_key=PRIVATE_KEY,
        max_payment_usd=0.25,
        build_body=lambda kwargs: {"wrapped": kwargs["text"]},
    )
    outcome = json.loads(tool.invoke({"text": "hi"}))
    assert outcome["result"]["echo"] == {"wrapped": "hi"}


def test_cap_must_be_positive() -> None:
    with pytest.raises(ValueError, match="positive"):
        payable_tool(
            name="echo",
            description="x",
            args_schema=EchoInput,
            url="http://127.0.0.1:1/paid",
            private_key=PRIVATE_KEY,
            max_payment_usd=0,
        )
