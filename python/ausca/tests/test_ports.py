"""Port tests: any payment authority, any artifact store, no local key."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import StringIO
from typing import Any

import httpx
import pytest
from ausca import (
    ArtifactError,
    AuscaClient,
    PaymentReceipt,
    RunxArtifactStore,
)
from ausca.cli import media_type_for, run

CATALOG = {
    "offers": [
        {
            "offer_id": "echo.test",
            "revision": "echo-r1",
            "revision_digest": "sha256:" + "a" * 64,
            "input_schema": {"digest": "sha256:" + "b" * 64, "public_path": "/schemas/echo.json"},
            "output_schema": {"digest": "sha256:" + "c" * 64},
            "canonicalizer_version": "runx.receipt.c14n.v1",
            "route": {"method": "POST", "path": "/v1/echo"},
            "title": "Echo Test",
            "description": "Echo one message back.",
            "artifact": {"input_mode": "none"},
            "price": {"currency": "USD", "model": "fixed", "minimum_minor": 1, "maximum_minor": 1},
        }
    ]
}


class _Service(BaseHTTPRequestHandler):
    seen: dict[str, int] = {}

    def log_message(self, *_args) -> None:  # noqa: N802
        pass

    def _json(self, status: int, body: dict[str, Any], headers: dict[str, str] | None = None) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/catalog.json":
            self._json(200, CATALOG)
        elif self.path.startswith("/v1/invocations/"):
            self._json(200, {"invocation_id": self.path.rsplit("/", 1)[-1], "state": "completed"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        if "X-TEST-CREDENTIAL" not in self.headers:
            type(self).seen["unsigned"] = type(self).seen.get("unsigned", 0) + 1
            self._json(402, {"status": "error", "code": "payment_required"})
            return
        type(self).seen["signed"] = type(self).seen.get("signed", 0) + 1
        self._json(200, {"status": "ok", "echo": body})


class DelegatedAuthority:
    """A stand-in for a delegated rail: it retries with its own credential."""

    rails = ("test-delegated",)

    def request(self, http: httpx.Client, method: str, url: str, json_body: dict | None):
        response = http.request(method=method, url=url, json=json_body)
        if response.status_code != 402:
            return response
        return http.request(
            method=method, url=url, json=json_body, headers={"X-TEST-CREDENTIAL": "delegated"}
        )

    def receipt(self, response: httpx.Response) -> PaymentReceipt | None:
        return PaymentReceipt(success=True, network="test", transaction="delegated", payer="test")


@pytest.fixture()
def service():
    _Service.seen = {}
    server = HTTPServer(("127.0.0.1", 0), _Service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


def test_invoke_works_through_any_payment_authority(service: str) -> None:
    client = AuscaClient(payment=DelegatedAuthority(), origin=service)
    outcome = client.invoke("echo.test", {"message": "via port"})
    assert outcome.result["status"] == "ok"
    assert outcome.payment is not None and outcome.payment.transaction == "delegated"
    assert _Service.seen == {"unsigned": 1, "signed": 1}


def test_reads_need_no_wallet(service: str) -> None:
    client = AuscaClient(origin=service)
    price = client.price("echo.test")
    assert price.currency == "USD" and price.minimum_minor == 1
    state = client.invocation("inv_1")
    assert state["state"] == "completed"


def test_cli_catalog_and_price(service: str) -> None:
    stdout = StringIO()
    assert run(["catalog"], {"AUSCA_ORIGIN": service}, stdout, StringIO()) == 0
    listing = json.loads(stdout.getvalue())
    assert listing[0]["offer_id"] == "echo.test"

    stdout = StringIO()
    assert run(["price", "echo.test"], {"AUSCA_ORIGIN": service}, stdout, StringIO()) == 0
    assert json.loads(stdout.getvalue())["model"] == "fixed"


def test_cli_refuses_key_without_cap(service: str) -> None:
    with pytest.raises(SystemExit, match="refusing to guess"):
        run(
            ["invoke", "echo.test", "{}"],
            {"AUSCA_ORIGIN": service, "AUSCA_PRIVATE_KEY": "0x" + "7" * 64},
            StringIO(),
            StringIO(),
        )


def test_media_types() -> None:
    assert media_type_for("scan.PDF") == "application/pdf"
    assert media_type_for("mystery.bin") == "application/octet-stream"


class _ArtifactService(BaseHTTPRequestHandler):
    operations: list[dict[str, Any]] = []

    def log_message(self, *_args) -> None:  # noqa: N802
        pass

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length))
        type(self).operations.append({**body, "authorization": self.headers.get("authorization")})
        data = json.dumps(
            {
                "operation": body["operation"],
                "access": "mutate",
                "result": {
                    "artifact_ref": "runx:artifact:sha256:" + "ab" * 32,
                    "content_digest": body["input"].get("content_digest", "sha256:" + "ab" * 32),
                    "media_type": "application/pdf",
                    "size_bytes": 3,
                    "created_at": "2026-09-03T00:00:00Z",
                },
            }
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def test_runx_artifact_store_allocates_and_hands_off() -> None:
    _ArtifactService.operations = []
    server = HTTPServer(("127.0.0.1", 0), _ArtifactService)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        store = RunxArtifactStore(
            token="runx-test-token", origin=f"http://127.0.0.1:{server.server_port}"
        )
        commitment = store.commit(b"pdf", "application/pdf")
        assert commitment.artifact_ref.startswith("runx:artifact:sha256:")
        assert commitment.content_digest.startswith("sha256:")
        allocate, handoff = _ArtifactService.operations
        assert allocate["operation"] == "artifact.allocate"
        assert allocate["authorization"] == "Bearer runx-test-token"
        assert allocate["input"]["idempotency_key"].startswith("ausca-artifact-")
        assert handoff["input"]["target_principal_id"] == "ausca"
        with pytest.raises(ArtifactError, match="empty artifact"):
            store.commit(b"", "application/pdf")
    finally:
        server.shutdown()
