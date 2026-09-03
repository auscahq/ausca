"""The Ausca client: catalog-bound paid invocations over x402 v2.

Payment construction and signing stay entirely in the official ``x402``
library; this module binds invocation envelopes to the immutable catalog,
enforces a hard per-call USD cap through the library's spend controls, and
returns results together with their decoded settlement proof.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

import httpx
from eth_account import Account
from eth_account.signers.local import LocalAccount
from x402 import SchemeRegistration, SpendControls, x402ClientConfig, x402ClientSync
from x402.http import x402HTTPClientSync
from x402.mechanisms.evm.exact import ExactEvmClientScheme
from x402.mechanisms.evm.signers import EthAccountSigner

ORIGIN = "https://ausca.com"
CATALOG_URL = f"{ORIGIN}/catalog.json"
SKILL_URL = f"{ORIGIN}/SKILL.md"

_PAYMENT_REQUIRED = "PAYMENT-REQUIRED"
_PAYMENT_RESPONSE = "PAYMENT-RESPONSE"


class AuscaError(Exception):
    """A refused, failed, or unpayable invocation."""


@dataclass(frozen=True)
class Offer:
    """One active offer's immutable binding from the live catalog."""

    offer_id: str
    revision: str
    revision_digest: str
    input_schema_digest: str
    output_schema_digest: str
    canonicalizer_version: str
    route_method: str
    route_path: str
    title: str
    description: str


@dataclass(frozen=True)
class PaymentReceipt:
    """Settlement proof decoded from the PAYMENT-RESPONSE header."""

    success: bool
    network: str | None
    transaction: str | None
    payer: str | None


@dataclass(frozen=True)
class InvocationResult:
    """The invocation outcome with its settlement proof when the call paid."""

    result: Any
    payment: PaymentReceipt | None
    status: int


class AuscaClient:
    """Discover offers and run paid invocations under an explicit spend cap.

    The signing key never leaves the process and the cap is enforced by the
    x402 client before anything is signed.
    """

    def __init__(
        self,
        *,
        private_key: str | None = None,
        account: LocalAccount | None = None,
        max_payment_usd: float,
        network: str = "eip155:8453",
        origin: str = ORIGIN,
        http: httpx.Client | None = None,
    ) -> None:
        if not max_payment_usd or max_payment_usd <= 0:
            raise ValueError("max_payment_usd must be a positive number")
        if account is None:
            if private_key is None:
                raise ValueError("one of account or private_key is required")
            account = Account.from_key(private_key)
        self._origin = origin.rstrip("/")
        self._http = http or httpx.Client(timeout=60)
        self._catalog: dict[str, Any] | None = None
        scheme = ExactEvmClientScheme(EthAccountSigner(account))
        client = x402ClientSync.from_config(
            x402ClientConfig(
                schemes=[SchemeRegistration(network=network, client=scheme, x402_version=2)],
                spend_controls=SpendControls(max_amount_per_payment=f"${max_payment_usd}"),
            )
        )
        self._payments = x402HTTPClientSync(client)

    def catalog(self, *, refresh: bool = False) -> dict[str, Any]:
        """The live immutable catalog, fetched once and cached."""
        if self._catalog is None or refresh:
            response = self._http.get(f"{self._origin}/catalog.json")
            response.raise_for_status()
            self._catalog = response.json()
        return self._catalog

    def offer(self, offer_id: str) -> Offer:
        """Resolve one active offer's immutable binding."""
        for entry in self.catalog().get("offers", []):
            if entry["offer_id"] == offer_id:
                return Offer(
                    offer_id=entry["offer_id"],
                    revision=entry["revision"],
                    revision_digest=entry["revision_digest"],
                    input_schema_digest=entry["input_schema"]["digest"],
                    output_schema_digest=entry["output_schema"]["digest"],
                    canonicalizer_version=entry["canonicalizer_version"],
                    route_method=entry["route"]["method"],
                    route_path=entry["route"]["path"],
                    title=entry["title"],
                    description=entry["description"],
                )
        raise AuscaError(f"offer {offer_id!r} is not active in the catalog")

    def envelope(
        self, offer: Offer, invocation_input: dict[str, Any], idempotency_key: str | None = None
    ) -> dict[str, Any]:
        """The exact invocation envelope for one offer.

        The default idempotency key derives from the offer and input, so an
        uncertain retry of the same request can never mint a second purchase.
        """
        if idempotency_key is None:
            preimage = json.dumps(
                [offer.offer_id, offer.revision_digest, invocation_input],
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
            idempotency_key = f"ausca-{hashlib.sha256(preimage).hexdigest()[:32]}"
        return {
            "offer_id": offer.offer_id,
            "offer_revision": offer.revision,
            "offer_revision_digest": offer.revision_digest,
            "input_schema_digest": offer.input_schema_digest,
            "output_schema_digest": offer.output_schema_digest,
            "canonicalizer_version": offer.canonicalizer_version,
            "input": invocation_input,
            "idempotency_key": idempotency_key,
        }

    def invoke(
        self,
        offer_id: str,
        invocation_input: dict[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> InvocationResult:
        """Run one paid invocation: probe, pay within the cap, return proof."""
        offer = self.offer(offer_id)
        body = self.envelope(offer, invocation_input, idempotency_key)
        return self.pay_request(
            f"{self._origin}{offer.route_path}", method=offer.route_method, json_body=body
        )

    def pay_request(
        self, url: str, *, method: str = "POST", json_body: dict[str, Any] | None = None
    ) -> InvocationResult:
        """One paid call against any x402 v2 resource, under the same cap."""
        request = {"method": method, "url": url, "json": json_body}
        response = self._http.request(**request)
        if response.status_code == 402:
            extra_headers, _payload = self._payments.handle_402_response(
                dict(response.headers), response.content, url
            )
            response = self._http.request(**request, headers=extra_headers)
        payment = self._payment_receipt(response)
        try:
            result: Any = response.json()
        except ValueError:
            result = response.text
        if response.status_code >= 400:
            raise AuscaError(
                f"payable resource {url} answered {response.status_code}: {response.text[:512]}"
            )
        return InvocationResult(result=result, payment=payment, status=response.status_code)

    def _payment_receipt(self, response: httpx.Response) -> PaymentReceipt | None:
        if _PAYMENT_RESPONSE not in response.headers:
            return None
        settled = self._payments.get_payment_settle_response(response.headers.get)
        return PaymentReceipt(
            success=bool(getattr(settled, "success", False)),
            network=getattr(settled, "network", None),
            transaction=getattr(settled, "transaction", None),
            payer=getattr(settled, "payer", None),
        )
