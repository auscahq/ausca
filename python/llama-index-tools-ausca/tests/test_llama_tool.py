"""Tests against an in-process x402 v2 resource: no chain, offline signing."""

from __future__ import annotations

import json

import pytest
from llama_index_tools_ausca import payable_tool
from pydantic import BaseModel

from conftest import _Resource

PRIVATE_KEY = "0x" + "7" * 64


class EchoInput(BaseModel):
    text: str


def test_tool_pays_within_cap_and_returns_settlement_proof(resource: str) -> None:
    receipts = []
    tool = payable_tool(
        name="echo",
        description="Calls the test payable resource.",
        fn_schema=EchoInput,
        url=resource,
        private_key=PRIVATE_KEY,
        max_payment_usd=0.25,
        on_payment=receipts.append,
    )
    outcome = json.loads(tool.call(text="hello").content)
    assert outcome["result"]["status"] == "ok"
    assert outcome["result"]["echo"]["text"] == "hello"
    assert outcome["payment"]["success"] is True
    assert len(receipts) == 1 and receipts[0].success
    assert _Resource.seen == {"unsigned": 1, "signed": 1}


def test_tool_refuses_to_pay_above_the_cap_before_signing(resource: str) -> None:
    _Resource.amount_atomic = "5000000"
    tool = payable_tool(
        name="echo",
        description="Calls the test payable resource.",
        fn_schema=EchoInput,
        url=resource,
        private_key=PRIVATE_KEY,
        max_payment_usd=0.25,
    )
    with pytest.raises(Exception):
        tool.call(text="hello")
    assert _Resource.seen.get("signed") is None
