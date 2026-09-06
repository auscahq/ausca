"""The shared payable-call kernel behind the tool factory.

One paid HTTP call: request, answer a 402 challenge with an x402 v2 payment
within an explicit per-call USD cap, and return the parsed result with its
decoded settlement proof. All payment construction and signing stays in the
official ``x402`` library; this module only configures it and shapes the
result. Nothing here is specific to one vendor.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx
from eth_account import Account
from eth_account.signers.local import LocalAccount
from x402 import SchemeRegistration, SpendControls, x402ClientConfig, x402ClientSync
from x402.http import x402HTTPClientSync
from x402.mechanisms.evm.exact import ExactEvmClientScheme
from x402.mechanisms.evm.signers import EthAccountSigner

_PAYMENT_RESPONSE = "PAYMENT-RESPONSE"


class PayableCallError(Exception):
    """A refused, failed, or unpayable call."""


@dataclass(frozen=True)
class PaymentReceipt:
    """Settlement proof decoded from the PAYMENT-RESPONSE header."""

    success: bool
    network: str | None
    transaction: str | None
    payer: str | None


@dataclass(frozen=True)
class PayableCallResult:
    """The parsed response body with its settlement proof when the call paid."""

    result: Any
    payment: PaymentReceipt | None
    status: int


class PayableCaller:
    """Pays 402 challenges for one signing account under a hard USD cap."""

    def __init__(
        self,
        *,
        private_key: str | None = None,
        account: LocalAccount | None = None,
        max_payment_usd: float,
        network: str = "eip155:8453",
        http: httpx.Client | None = None,
    ) -> None:
        if not max_payment_usd or max_payment_usd <= 0:
            raise ValueError("max_payment_usd must be a positive number")
        if (account is None) == (private_key is None):
            raise ValueError("provide exactly one of account or private_key")
        if account is None:
            account = Account.from_key(private_key)
        self._http = http or httpx.Client(timeout=60)
        scheme = ExactEvmClientScheme(EthAccountSigner(account))
        client = x402ClientSync.from_config(
            x402ClientConfig(
                schemes=[SchemeRegistration(network=network, client=scheme, x402_version=2)],
                spend_controls=SpendControls(max_amount_per_payment=f"${max_payment_usd}"),
            )
        )
        self._payments = x402HTTPClientSync(client)

    def call(
        self,
        url: str,
        *,
        method: str = "POST",
        json_body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> PayableCallResult:
        response = self._http.request(method=method, url=url, json=json_body, headers=headers)
        if response.status_code == 402:
            extra_headers, _payload = self._payments.handle_402_response(
                dict(response.headers), response.content, url
            )
            merged = {**(headers or {}), **extra_headers}
            response = self._http.request(method=method, url=url, json=json_body, headers=merged)
        payment = self._receipt(response)
        try:
            result: Any = response.json()
        except ValueError:
            result = response.text
        if response.status_code >= 400:
            raise PayableCallError(
                f"payable resource {url} answered {response.status_code}: {response.text[:512]}"
            )
        return PayableCallResult(result=result, payment=payment, status=response.status_code)

    def _receipt(self, response: httpx.Response) -> PaymentReceipt | None:
        if _PAYMENT_RESPONSE not in response.headers:
            return None
        settled = self._payments.get_payment_settle_response(response.headers.get)
        return PaymentReceipt(
            success=bool(getattr(settled, "success", False)),
            network=getattr(settled, "network", None),
            transaction=getattr(settled, "transaction", None),
            payer=getattr(settled, "payer", None),
        )
