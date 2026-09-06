"""Shared in-process x402 v2 resource fixture: no chain, offline signing."""

from __future__ import annotations

import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
PRIVATE_KEY = "0x" + "7" * 64


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


