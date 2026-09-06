"""Artifact commitments for document and media offers.

Artifact-backed offers take an immutable input commitment instead of raw
bytes. This port turns bytes into that commitment; Ausca's keyless ingress is
the default implementation and custom stores remain an explicit seam.
"""

from __future__ import annotations

import base64
import hashlib
import re
from dataclasses import dataclass
from typing import Protocol

import httpx

AUSCA_ORIGIN = "https://ausca.com"
MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
ARTIFACT_REF_PATTERN = re.compile(r"^runx:artifact:sha256:[0-9a-f]{64}$")


class ArtifactError(Exception):
    """A refused or failed artifact operation."""


@dataclass(frozen=True)
class ArtifactCommitment:
    """The immutable input commitment an artifact-backed offer requires."""

    artifact_ref: str
    content_digest: str
    media_type: str


class ArtifactStore(Protocol):
    """Stores bytes and returns the commitment the invocation input carries."""

    def commit(self, data: bytes, media_type: str) -> ArtifactCommitment: ...


class AuscaArtifactStore:
    """Commits bytes through Ausca's keyless temporary artifact ingress."""

    def __init__(
        self,
        *,
        origin: str = AUSCA_ORIGIN,
        http: httpx.Client | None = None,
    ) -> None:
        self._origin = origin.rstrip("/")
        self._http = http or httpx.Client(timeout=120)

    def commit(self, data: bytes, media_type: str) -> ArtifactCommitment:
        if not data or len(data) > MAX_ARTIFACT_BYTES:
            raise ArtifactError(f"artifact must contain 1 to {MAX_ARTIFACT_BYTES} bytes")
        if not media_type or media_type.strip() != media_type or len(media_type) > 200:
            raise ArtifactError("artifact media type is invalid")
        digest_hex = hashlib.sha256(data).hexdigest()
        content_digest = f"sha256:{digest_hex}"
        request_hex = hashlib.sha256(
            f"{content_digest}\n{media_type}".encode()
        ).hexdigest()
        response = self._http.post(
            f"{self._origin}/v1/artifacts",
            json={
                "data_base64": base64.b64encode(data).decode(),
                "content_digest": content_digest,
                "media_type": media_type,
                "idempotency_key": f"ausca-artifact-{request_hex[:32]}",
            },
        )
        if response.status_code >= 400:
            raise ArtifactError(
                f"artifact ingress answered {response.status_code}: {response.text[:512]}"
            )
        try:
            result = response.json()
        except ValueError as error:
            raise ArtifactError("artifact ingress answered non-JSON") from error
        if set(result) != {"status", "artifact"} or result["status"] != "stored":
            raise ArtifactError("artifact ingress returned malformed evidence")
        evidence = result["artifact"]
        if not isinstance(evidence, dict) or set(evidence) != {
            "artifact_ref", "content_digest", "created_at", "media_type", "size_bytes"
        }:
            raise ArtifactError("artifact ingress returned malformed evidence")
        # The service mints its own storage identity, so the reference is the
        # one field the caller cannot derive. Everything the local bytes prove
        # is checked against them; the minted reference is checked for shape.
        artifact_ref = evidence["artifact_ref"]
        if (
            not isinstance(artifact_ref, str)
            or not ARTIFACT_REF_PATTERN.match(artifact_ref)
            or evidence["content_digest"] != content_digest
            or evidence["media_type"] != media_type
            or evidence["size_bytes"] != len(data)
            or not isinstance(evidence["created_at"], str)
        ):
            raise ArtifactError("artifact ingress returned mismatched evidence")
        return ArtifactCommitment(
            artifact_ref=artifact_ref, content_digest=content_digest, media_type=media_type
        )
