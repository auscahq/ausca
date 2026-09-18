"""The Ausca client: catalog-bound paid invocations.

It resolves an offer's immutable binding from the live catalog, builds the
exact envelope with a caller-stable idempotency key, and pays the offer's
own payable resource through the configured payment authority. Rails are
authority implementations, never client concerns.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

import httpx
from eth_account.signers.local import LocalAccount

from ausca.artifacts import ArtifactCommitment, ArtifactStore, AuscaArtifactStore
from ausca.payment import (
    InertAuthority,
    LocalKeyAuthority,
    PaymentAuthority,
    PaymentReceipt,
)

ORIGIN = "https://ausca.com"
CATALOG_URL = f"{ORIGIN}/catalog.json"
SKILL_URL = f"{ORIGIN}/SKILL.md"


class AuscaError(Exception):
    """A refused, failed, or unpayable invocation."""


@dataclass(frozen=True)
class PriceOption:
    """One price option of an input_choice offer."""

    amount_minor: int
    value: Any


@dataclass(frozen=True)
class Price:
    """The published price policy of one active offer."""

    currency: str
    model: str
    minimum_minor: int
    maximum_minor: int
    options: tuple[PriceOption, ...] | None
    input_field: str | None


@dataclass(frozen=True)
class Offer:
    """One active offer's immutable binding from the live catalog."""

    offer_id: str
    revision: str
    revision_digest: str
    input_schema_digest: str
    input_schema_path: str
    output_schema_digest: str
    route_method: str
    route_path: str
    title: str
    description: str
    price: Price
    artifact_input_mode: str


@dataclass(frozen=True)
class InvocationResult:
    """The invocation outcome with its settlement proof when the call paid."""

    result: Any
    payment: PaymentReceipt | None
    status: int


class AuscaClient:
    """Discover offers and run paid invocations under an explicit policy.

    Payment flows through a ``PaymentAuthority``; the default local-key
    authority enforces a hard per-call USD cap before anything is signed
    and keys never leave the process.
    """

    def __init__(
        self,
        *,
        payment: PaymentAuthority | None = None,
        artifacts: ArtifactStore | None = None,
        origin: str = ORIGIN,
        http: httpx.Client | None = None,
    ) -> None:
        self._origin = origin.rstrip("/")
        self._http = http or httpx.Client(timeout=60)
        self._payment: PaymentAuthority = payment or InertAuthority()
        self._artifacts = artifacts or AuscaArtifactStore(origin=self._origin, http=self._http)
        self._catalog: dict[str, Any] | None = None

    @classmethod
    def with_local_key(
        cls,
        *,
        private_key: str | None = None,
        account: LocalAccount | None = None,
        max_payment_usd: float,
        network: str = "eip155:8453",
        origin: str = ORIGIN,
        artifacts: ArtifactStore | None = None,
        http: httpx.Client | None = None,
    ) -> "AuscaClient":
        """Sugar for the default rail: a local signing key under a hard USD cap."""
        return cls(
            payment=LocalKeyAuthority(
                private_key=private_key,
                account=account,
                max_payment_usd=max_payment_usd,
                network=network,
            ),
            artifacts=artifacts,
            origin=origin,
            http=http,
        )

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
                price = entry.get("price", {})
                options = price.get("options")
                return Offer(
                    offer_id=entry["offer_id"],
                    revision=entry["revision"],
                    revision_digest=entry["revision_digest"],
                    input_schema_digest=entry["input_schema"]["digest"],
                    input_schema_path=entry["input_schema"].get("public_path", ""),
                    output_schema_digest=entry["output_schema"]["digest"],
                    route_method=entry["route"]["method"],
                    route_path=entry["route"]["path"],
                    title=entry["title"],
                    description=entry["description"],
                    artifact_input_mode=entry.get("artifact", {}).get("input_mode", "none"),
                    price=Price(
                        currency=price.get("currency", "USD"),
                        model=price.get("model", ""),
                        minimum_minor=price.get("minimum_minor", 0),
                        maximum_minor=price.get("maximum_minor", 0),
                        input_field=price.get("input_field"),
                        options=tuple(
                            PriceOption(amount_minor=option["amount_minor"], value=option["value"])
                            for option in options
                        )
                        if options
                        else None,
                    ),
                )
        raise AuscaError(f"offer {offer_id!r} is not active in the catalog")

    def price(self, offer_id: str) -> Price:
        """The published price policy of one offer. No wallet is needed."""
        return self.offer(offer_id).price

    def envelope(
        self, offer: Offer, invocation_input: dict[str, Any], idempotency_key: str | None = None
    ) -> dict[str, Any]:
        """The exact invocation envelope for one offer.

        A fresh default key starts one intentional purchase. Supply the same
        explicit key to recover or retry that purchase without minting another.
        """
        if idempotency_key is None:
            idempotency_key = f"ausca-{uuid.uuid4()}"
        key_bytes = idempotency_key.encode("utf-8")
        if (
            not 16 <= len(key_bytes) <= 128
            or idempotency_key.strip() != idempotency_key
            or any(ord(character) < 0x20 or ord(character) == 0x7F for character in idempotency_key)
        ):
            raise AuscaError("idempotency_key must be 16 to 128 clean UTF-8 bytes")
        return {
            "offer_id": offer.offer_id,
            "offer_revision": offer.revision,
            "offer_revision_digest": offer.revision_digest,
            "input_schema_digest": offer.input_schema_digest,
            "output_schema_digest": offer.output_schema_digest,
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
        """Run one paid invocation: probe, pay within policy, return proof."""
        offer = self.offer(offer_id)
        body = self.envelope(offer, invocation_input, idempotency_key)
        return self.pay_request(
            f"{self._origin}{offer.route_path}", method=offer.route_method, json_body=body
        )

    def pay_request(
        self, url: str, *, method: str = "POST", json_body: dict[str, Any] | None = None
    ) -> InvocationResult:
        """One paid call against any resource the configured authority can pay."""
        response = self._payment.request(self._http, method, url, json_body)
        payment = self._payment.receipt(response)
        try:
            result: Any = response.json()
        except ValueError:
            result = response.text
        if response.status_code >= 400:
            raise AuscaError(
                f"payable resource {url} answered {response.status_code}: {response.text[:512]}"
            )
        return InvocationResult(result=result, payment=payment, status=response.status_code)

    def invocation(self, invocation_id: str) -> dict[str, Any]:
        """Read authoritative durable invocation state without a new purchase."""
        response = self._http.get(f"{self._origin}/v1/invocations/{invocation_id}")
        if response.status_code >= 400:
            raise AuscaError(f"invocation read answered {response.status_code}")
        return response.json()

    def commit(
        self,
        data: bytes,
        media_type: str,
        *,
        idempotency_key: str | None = None,
    ) -> ArtifactCommitment:
        """Commit input bytes through the configured artifact store."""
        if idempotency_key is None:
            return self._artifacts.commit(data, media_type)
        return self._artifacts.commit(
            data,
            media_type,
            idempotency_key=idempotency_key,
        )

    def artifact_access(self, artifact_ref: str, idempotency_key: str | None = None) -> dict[str, Any]:
        """Mint a 60-second download URL for an artifact this service holds.

        Use it for an invocation's ``output_artifact``. Verify downloaded bytes
        against ``content_digest``; the URL itself is not proof of content.
        """
        response = self._http.post(
            f"{self._origin}/v1/artifacts/{artifact_ref}/access",
            headers={"Idempotency-Key": idempotency_key or f"ausca-{uuid.uuid4()}"},
        )
        body = response.json() if response.status_code < 400 else None
        if not isinstance(body, dict) or body.get("status") != "ready":
            raise AuscaError(f"artifact access answered {response.status_code}")
        return body["artifact"]
