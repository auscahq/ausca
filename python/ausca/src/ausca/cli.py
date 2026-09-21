"""The front-door verbs, mirroring the npm ``ausca`` bin.

Configuration is environment only: a signing key and a mandatory per-call
USD cap for paying verbs, nothing else. Artifact commits are keyless. Output
is JSON on stdout.
"""

from __future__ import annotations

import dataclasses
import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping, TextIO

from ausca.client import AuscaClient, ORIGIN

USAGE = """ausca: metered agent infrastructure services, paid per call

  ausca catalog                    active offers, prices, routes
  ausca price <offer-id> [--json]  published price and immutable binding
  ausca invoke <offer-id> [input] --idempotency-key <key>
                                     paid invocation; input JSON, file, @file, or stdin
  ausca commit <file> [--idempotency-key <key>]
                                     artifact commitment for document and media offers

Environment: AUSCA_PRIVATE_KEY and AUSCA_MAX_PAYMENT_USD pay invocations;
AUSCA_NETWORK overrides the payment network; AUSCA_ORIGIN overrides the service.
The MCP server ships in the npm package: npx ausca mcp.
Save one unique purchase key (16–128 bytes) before invoking. After an uncertain
response, reuse that key and the same input; a new key authorizes a new purchase."""

MEDIA_TYPES = {
    "pdf": "application/pdf",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "tif": "image/tiff",
    "tiff": "image/tiff",
    "txt": "text/plain",
    "md": "text/markdown",
    "html": "text/html",
    "csv": "text/csv",
    "json": "application/json",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "m4a": "audio/mp4",
    "flac": "audio/flac",
    "ogg": "audio/ogg",
    "mp4": "video/mp4",
    "mov": "video/quicktime",
    "webm": "video/webm",
    "mkv": "video/x-matroska",
}


def media_type_for(name: str) -> str:
    return MEDIA_TYPES.get(name.lower().rsplit(".", 1)[-1], "application/octet-stream")


def _client(env: Mapping[str, str], *, require_payment: bool = False) -> AuscaClient:
    origin = env.get("AUSCA_ORIGIN", ORIGIN)
    key = env.get("AUSCA_PRIVATE_KEY")
    if not key:
        if require_payment:
            raise SystemExit(
                "paid invocations need AUSCA_PRIVATE_KEY and AUSCA_MAX_PAYMENT_USD"
                " in the environment"
            )
        return AuscaClient(origin=origin)
    try:
        cap = float(env.get("AUSCA_MAX_PAYMENT_USD", ""))
    except ValueError:
        cap = 0.0
    if cap <= 0:
        raise SystemExit(
            "AUSCA_MAX_PAYMENT_USD must be a positive USD amount when"
            " AUSCA_PRIVATE_KEY is set; refusing to guess a spend limit"
        )
    return AuscaClient.with_local_key(
        private_key=key,
        max_payment_usd=cap,
        network=env.get("AUSCA_NETWORK", "eip155:8453"),
        origin=origin,
    )


def _json(value: Any) -> str:
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        value = dataclasses.asdict(value)
    return json.dumps(value, indent=2, default=lambda item: dataclasses.asdict(item))


def _resolve_input(argument: str | None, stdin: TextIO) -> dict[str, Any]:
    if argument is None or argument == "-":
        text = stdin.read()
    elif argument.startswith("@"):
        text = Path(argument[1:]).read_text()
    else:
        try:
            return json.loads(argument)
        except ValueError:
            try:
                text = Path(argument).read_text()
            except OSError as error:
                raise SystemExit(
                    "input must be JSON, a readable file path, @file, or - for stdin"
                ) from error
    try:
        return json.loads(text)
    except ValueError as error:
        raise SystemExit("invocation input must be valid JSON") from error


def _invocation_args(argv: list[str]) -> tuple[str, str | None, str | None]:
    if not argv:
        raise SystemExit(
            "usage: ausca invoke <offer-id> [input] [--idempotency-key <key>]"
        )
    offer_id = argv[0]
    input_argument: str | None = None
    idempotency_key: str | None = None
    index = 1
    while index < len(argv):
        argument = argv[index]
        if argument == "--idempotency-key":
            if idempotency_key is not None or index + 1 >= len(argv):
                raise SystemExit("--idempotency-key requires one value")
            idempotency_key = argv[index + 1]
            index += 2
        elif input_argument is None:
            input_argument = argument
            index += 1
        else:
            raise SystemExit(f"unexpected invoke argument {argument}")
    return offer_id, input_argument, idempotency_key


def _commit_args(argv: list[str]) -> tuple[str, str | None]:
    file: str | None = None
    idempotency_key: str | None = None
    index = 0
    while index < len(argv):
        argument = argv[index]
        if argument == "--idempotency-key":
            if idempotency_key is not None or index + 1 >= len(argv):
                raise SystemExit("--idempotency-key requires one value")
            idempotency_key = argv[index + 1]
            index += 2
        elif file is None:
            file = argument
            index += 1
        else:
            raise SystemExit(f"unexpected commit argument {argument}")
    if file is None:
        raise SystemExit("usage: ausca commit <file> [--idempotency-key <key>]")
    return file, idempotency_key


def run(
    argv: list[str],
    env: Mapping[str, str],
    stdout: TextIO,
    stdin: TextIO,
) -> int:
    verb = argv[0] if argv else None
    if verb in (None, "help", "--help"):
        print(USAGE, file=stdout)
        return 1 if verb is None else 0
    if verb == "catalog":
        offers = _client(env).catalog().get("offers", [])
        listing = [
            {key: offer.get(key) for key in ("offer_id", "title", "route", "price", "revision")}
            for offer in offers
        ]
        print(_json(listing), file=stdout)
        return 0
    if verb == "price":
        arguments = [value for value in argv[1:] if value != "--json"]
        if len(arguments) != 1 or arguments[0].startswith("--"):
            raise SystemExit("usage: ausca price <offer-id> [--json]")
        offer = _client(env).offer(arguments[0])
        print(_json({
            **dataclasses.asdict(offer.price),
            "offer_id": offer.offer_id, "offer_revision": offer.revision,
            "offer_revision_digest": offer.revision_digest,
            "pricing_policy_digest": offer.pricing_policy_digest,
            "input_schema_digest": offer.input_schema_digest,
            "output_schema_digest": offer.output_schema_digest,
            "route": {"method": offer.route_method, "path": offer.route_path},
        }), file=stdout)
        return 0
    if verb == "invoke":
        offer_id, input_argument, idempotency_key = _invocation_args(argv[1:])
        client = _client(env, require_payment=True)
        if idempotency_key is None:
            raise SystemExit(
                "paid invocations require --idempotency-key <key> (16–128 bytes). "
                "Save it before paying; reuse it with the same input to recover. "
                "A new key buys again."
            )
        outcome = client.invoke(
            offer_id,
            _resolve_input(input_argument, stdin),
            idempotency_key=idempotency_key,
        )
        print(_json(outcome), file=stdout)
        return 0
    if verb == "commit":
        file, idempotency_key = _commit_args(argv[1:])
        path = Path(file)
        commitment = _client(env).commit(
            path.read_bytes(),
            media_type_for(path.name),
            idempotency_key=idempotency_key,
        )
        print(_json(commitment), file=stdout)
        return 0
    raise SystemExit(f"unknown verb {verb}; run ausca help")


def main() -> None:
    try:
        sys.exit(run(sys.argv[1:], os.environ, sys.stdout, sys.stdin))
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - the CLI boundary reports and exits
        print(str(error), file=sys.stderr)
        sys.exit(1)
