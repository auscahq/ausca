"""The front-door verbs, mirroring the npm ``ausca`` bin.

Configuration is environment only: a signing key and a mandatory per-call
USD cap for paying verbs, a Runx token for artifact commits, nothing else.
Output is JSON on stdout.
"""

from __future__ import annotations

import dataclasses
import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping, TextIO

from ausca.artifacts import ArtifactStore, RunxArtifactStore
from ausca.client import AuscaClient, ORIGIN

USAGE = """ausca: metered agent infrastructure services, paid per call

  ausca catalog                    active offers, prices, routes
  ausca price <offer-id>           published price policy
  ausca invoke <offer-id> [input]  paid invocation; input inline, @file, or stdin
  ausca commit <file>              artifact commitment for document and media offers

Environment: AUSCA_PRIVATE_KEY and AUSCA_MAX_PAYMENT_USD pay invocations;
AUSCA_NETWORK overrides the payment network; RUNX_API_TOKEN enables commit.
The MCP server ships in the npm package: npx ausca mcp."""

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


def _artifacts(env: Mapping[str, str]) -> ArtifactStore | None:
    token = env.get("RUNX_API_TOKEN")
    return RunxArtifactStore(token=token) if token else None


def _client(env: Mapping[str, str], *, require_payment: bool = False) -> AuscaClient:
    origin = env.get("AUSCA_ORIGIN", ORIGIN)
    key = env.get("AUSCA_PRIVATE_KEY")
    if not key:
        if require_payment:
            raise SystemExit(
                "paid invocations need AUSCA_PRIVATE_KEY and AUSCA_MAX_PAYMENT_USD"
                " in the environment"
            )
        return AuscaClient(origin=origin, artifacts=_artifacts(env))
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
        artifacts=_artifacts(env),
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
        text = argument
    try:
        return json.loads(text)
    except ValueError as error:
        raise SystemExit("invocation input must be valid JSON") from error


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
        if len(argv) < 2:
            raise SystemExit("usage: ausca price <offer-id>")
        print(_json(_client(env).price(argv[1])), file=stdout)
        return 0
    if verb == "invoke":
        if len(argv) < 2:
            raise SystemExit("usage: ausca invoke <offer-id> [input]")
        client = _client(env, require_payment=True)
        outcome = client.invoke(argv[1], _resolve_input(argv[2] if len(argv) > 2 else None, stdin))
        print(_json(outcome), file=stdout)
        return 0
    if verb == "commit":
        if len(argv) < 2:
            raise SystemExit("usage: ausca commit <file>")
        store = _artifacts(env)
        if store is None:
            raise SystemExit("artifact commits need RUNX_API_TOKEN in the environment")
        path = Path(argv[1])
        commitment = store.commit(path.read_bytes(), media_type_for(path.name))
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
