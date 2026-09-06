"""LlamaIndex tools that pay for HTTP 402 APIs over x402.

A tool built here consumes a paid HTTP API by answering its 402 challenge
with an x402 v2 payment instead of carrying an API key. It works against any
x402 v2 resource; nothing in it is specific to one vendor. The model authors
the request; the caller's signing key and hard per-call USD cap stay outside
the model's reach.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from typing import Any, Callable

import httpx
from eth_account.signers.local import LocalAccount
from llama_index.core.tools import FunctionTool

from llama_index_tools_ausca._payable import (
    PayableCallError,
    PayableCaller,
    PayableCallResult,
    PaymentReceipt,
)

__all__ = [
    "PayableCallError",
    "PayableCallResult",
    "PaymentReceipt",
    "payable_tool",
]


def payable_tool(
    *,
    name: str,
    description: str,
    fn_schema: Any,
    url: str,
    method: str = "POST",
    private_key: str | None = None,
    account: LocalAccount | None = None,
    network: str = "eip155:8453",
    max_payment_usd: float,
    headers: dict[str, str] | None = None,
    build_body: Callable[[dict[str, Any]], Any] | None = None,
    on_payment: Callable[[PaymentReceipt], None] | None = None,
    http: httpx.Client | None = None,
) -> FunctionTool:
    """Build a LlamaIndex function tool over one x402 payable resource.

    The tool result is a JSON string carrying the resource result and, when
    the call was paid, the decoded settlement proof. ``max_payment_usd`` is
    enforced by the x402 client's spend controls before anything is signed;
    the model can author the request, never the spend authority.
    """
    caller = PayableCaller(
        private_key=private_key,
        account=account,
        max_payment_usd=max_payment_usd,
        network=network,
        http=http,
    )

    def _run(**kwargs: Any) -> str:
        body = build_body(kwargs) if build_body else kwargs
        outcome = caller.call(url, method=method, json_body=body, headers=headers)
        if outcome.payment and on_payment:
            on_payment(outcome.payment)
        payment = asdict(outcome.payment) if outcome.payment else None
        return json.dumps({"result": outcome.result, "payment": payment})

    return FunctionTool.from_defaults(
        fn=_run,
        name=name,
        description=description,
        fn_schema=fn_schema,
    )
