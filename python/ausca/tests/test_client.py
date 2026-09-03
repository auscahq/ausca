"""Tests against an in-process x402 v2 resource: no chain, offline signing."""

from __future__ import annotations

import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from ausca import AuscaClient, AuscaError

BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
PRIVATE_KEY = "0x" + "7" * 64

CATALOG = {
    "offers": [
        {
            "offer_id": "document.ocr",
            "revision": "ocr-fixed-r6",
            "revision_digest": "sha256:" + "a" * 64,
            "input_schema": {"digest": "sha256:" + "b" * 64},
            "output_schema": {"digest": "sha256:" + "c" * 64},
            "canonicalizer_version": "runx.receipt.c14n.v1",
            "route": {"method": "POST", "path": "/v1/extract-text"},
            "title": "Document OCR",
            "description": "Extract normalized text from a scanned document.",
        }
    ]
}


class _Resource(BaseHTTPRequestHandler):
    amount_atomic = "50000"
    seen: dict[str, int] = {}

    def log_message(self, *_args) -> None:  # noqa: N802
        pass

    def do_GET(self) -> None:  # noqa: N802
        body = json.dumps(CATALOG).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


def test_invoke_pays_within_cap_and_returns_settlement_proof(resource: str) -> None:
    client = AuscaClient.with_local_key(private_key=PRIVATE_KEY, max_payment_usd=0.25, origin=resource)
    outcome = client.invoke("document.ocr", {"artifact": {"ref": "runx:artifact:x"}})
    assert outcome.result["status"] == "ok"
    envelope = outcome.result["echo"]
    assert envelope["offer_id"] == "document.ocr"
    assert envelope["offer_revision_digest"] == "sha256:" + "a" * 64
    assert envelope["idempotency_key"].startswith("ausca-")
    assert outcome.payment is not None and outcome.payment.success
    assert outcome.payment.transaction.startswith("0x")
    assert _Resource.seen == {"unsigned": 1, "signed": 1}


def test_new_calls_get_distinct_keys_and_explicit_recovery_key_is_preserved(resource: str) -> None:
    client = AuscaClient.with_local_key(private_key=PRIVATE_KEY, max_payment_usd=0.25, origin=resource)
    offer = client.offer("document.ocr")
    first = client.envelope(offer, {"a": 1})["idempotency_key"]
    second = client.envelope(offer, {"a": 1})["idempotency_key"]
    recovered = client.envelope(offer, {"a": 1}, "purchase-20260903-0001")
    assert first != second
    assert recovered["idempotency_key"] == "purchase-20260903-0001"
    with pytest.raises(AuscaError, match="16 to 128 clean UTF-8 bytes"):
        client.envelope(offer, {"a": 1}, "too-short")
    with pytest.raises(AuscaError, match="16 to 128 clean UTF-8 bytes"):
        client.envelope(offer, {"a": 1}, "🙂" * 40)
    with pytest.raises(AuscaError, match="16 to 128 clean UTF-8 bytes"):
        client.envelope(offer, {"a": 1}, "purchase-20260903\n0001")


def test_refuses_to_pay_above_the_cap_before_signing(resource: str) -> None:
    _Resource.amount_atomic = "5000000"
    client = AuscaClient.with_local_key(private_key=PRIVATE_KEY, max_payment_usd=0.25, origin=resource)
    with pytest.raises(Exception):
        client.invoke("document.ocr", {"artifact": {"ref": "runx:artifact:x"}})
    assert _Resource.seen.get("signed") is None
