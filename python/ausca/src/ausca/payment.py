"""The payment boundary of the client.

The core never sees a rail, a header name, a scheme, or a wallet: it hands
the request to the configured authority and asks it to decode settlement
evidence. Any rail that can answer an HTTP 402 challenge fits, including
delegated executors that perform their own transport. Cap enforcement lives
inside the authority, before anything is signed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

import httpx
from eth_account import Account
from eth_account.signers.local import LocalAccount
from x402 import SchemeRegistration, SpendControls, x402ClientConfig, x402ClientSync
from x402.http import x402HTTPClientSync
from x402.mechanisms.evm.exact import ExactEvmClientScheme
from x402.mechanisms.evm.signers import EthAccountSigner

_PAYMENT_RESPONSE = "PAYMENT-RESPONSE"


@dataclass(frozen=True)
class PaymentReceipt:
    """Settlement proof decoded from a paid response."""

    success: bool
    network: str | None
    transaction: str | None
    payer: str | None


class PaymentAuthority(Protocol):
    """A payment rail the client can pay HTTP 402 challenges with."""

    rails: tuple[str, ...]

    def request(
        self,
        http: httpx.Client,
        method: str,
        url: str,
        json_body: dict[str, Any] | None,
    ) -> httpx.Response:
        """Perform the request, paying any challenge it understands within policy."""

    def receipt(self, response: httpx.Response) -> PaymentReceipt | None:
        """Decode settlement evidence from a completed response, if present."""


class InertAuthority:
    """An authority that pays nothing: reads, price discovery, tests."""

    rails: tuple[str, ...] = ()

    def request(
        self,
        http: httpx.Client,
        method: str,
        url: str,
        json_body: dict[str, Any] | None,
    ) -> httpx.Response:
        return http.request(method=method, url=url, json=json_body)

    def receipt(self, response: httpx.Response) -> PaymentReceipt | None:
        return None


class LocalKeyAuthority:
    """The zero-friction default rail: x402 v2 with a local signing key.

    Payment construction and signing stay entirely in the official ``x402``
    library; the hard per-call USD cap is enforced by its spend controls
    before anything is signed.
    """

    rails: tuple[str, ...] = ("x402-v2",)

    def __init__(
        self,
        *,
        private_key: str | None = None,
        account: LocalAccount | None = None,
        max_payment_usd: float,
        network: str = "eip155:8453",
    ) -> None:
        if not max_payment_usd or max_payment_usd <= 0:
            raise ValueError("max_payment_usd must be a positive number")
        if (account is None) == (private_key is None):
            raise ValueError("provide exactly one of account or private_key")
        if account is None:
            account = Account.from_key(private_key)
        scheme = ExactEvmClientScheme(EthAccountSigner(account))
        client = x402ClientSync.from_config(
            x402ClientConfig(
                schemes=[SchemeRegistration(network=network, client=scheme, x402_version=2)],
                spend_controls=SpendControls(max_amount_per_payment=f"${max_payment_usd}"),
            )
        )
        self._payments = x402HTTPClientSync(client)

    def request(
        self,
        http: httpx.Client,
        method: str,
        url: str,
        json_body: dict[str, Any] | None,
    ) -> httpx.Response:
        response = http.request(method=method, url=url, json=json_body)
        if response.status_code != 402:
            return response
        extra_headers, _payload = self._payments.handle_402_response(
            dict(response.headers), response.content, url
        )
        return http.request(method=method, url=url, json=json_body, headers=extra_headers)

    def receipt(self, response: httpx.Response) -> PaymentReceipt | None:
        if _PAYMENT_RESPONSE not in response.headers:
            return None
        settled = self._payments.get_payment_settle_response(response.headers.get)
        return PaymentReceipt(
            success=bool(getattr(settled, "success", False)),
            network=getattr(settled, "network", None),
            transaction=getattr(settled, "transaction", None),
            payer=getattr(settled, "payer", None),
        )
