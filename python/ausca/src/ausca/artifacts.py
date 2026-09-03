"""Artifact commitments for document and media offers.

Artifact-backed offers take an immutable input commitment instead of raw
bytes. This port turns bytes into that commitment; the hosted Runx store is
the day-one implementation. A future ingestion rail slots in behind the same
interface with no client API change.
"""

from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

RUNX_ORIGIN = "https://api.runx.ai"


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


class RunxArtifactStore:
    """Commits bytes through the hosted Runx artifact boundary.

    One digest-idempotent allocation, then one explicit handoff copy to the
    execution principal. Both idempotency keys derive from the content
    digest, so an uncertain retry can never duplicate storage or handoff.
    """

    def __init__(
        self,
        *,
        token: str,
        origin: str = RUNX_ORIGIN,
        target_principal_id: str = "ausca",
        run_context: str = "ausca-sdk",
        http: httpx.Client | None = None,
    ) -> None:
        self._token = token
        self._origin = origin.rstrip("/")
        self._target = target_principal_id
        self._run_context = run_context
        self._http = http or httpx.Client(timeout=120)

    def _operation(self, body: dict[str, Any]) -> dict[str, Any]:
        response = self._http.post(
            f"{self._origin}/v1/artifact-operations",
            json=body,
            headers={"authorization": f"Bearer {self._token}"},
        )
        if response.status_code >= 400:
            raise ArtifactError(
                f"artifact operation {body['operation']} answered "
                f"{response.status_code}: {response.text[:512]}"
            )
        return response.json()

    def commit(self, data: bytes, media_type: str) -> ArtifactCommitment:
        if not data:
            raise ArtifactError("cannot commit an empty artifact")
        digest_hex = hashlib.sha256(data).hexdigest()
        content_digest = f"sha256:{digest_hex}"
        allocated = self._operation(
            {
                "operation": "artifact.allocate",
                "run_id": self._run_context,
                "input": {
                    "idempotency_key": f"ausca-artifact-{digest_hex[:32]}",
                    "data_base64": base64.b64encode(data).decode(),
                    "content_digest": content_digest,
                    "media_type": media_type,
                },
            }
        )
        artifact_ref = (allocated.get("result") or {}).get("artifact_ref")
        if not isinstance(artifact_ref, str):
            raise ArtifactError("allocation returned no artifact reference")
        self._operation(
            {
                "operation": "artifact.handoff",
                "run_id": self._run_context,
                "input": {
                    "idempotency_key": f"ausca-handoff-{digest_hex[:32]}",
                    "source_artifact_ref": artifact_ref,
                    "target_principal_id": self._target,
                },
            }
        )
        return ArtifactCommitment(
            artifact_ref=artifact_ref, content_digest=content_digest, media_type=media_type
        )
