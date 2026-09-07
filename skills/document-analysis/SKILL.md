---
name: document-analysis
description: Extract structured document data through Ausca's measured asynchronous document analysis service.
---

# Ausca Document Analysis

Use Document Analysis when an agent needs normalized forms, tables, signatures,
or layout from one PDF or page image. The service is asynchronous. The price
is $0.30 to $0.75 USD for an artifact up to 10 MiB, sized by artifact bytes;
preparation fixes the exact amount before approval.

Use Document OCR when normalized text and line confidence are enough. Analysis
does not interpret business meaning, answer questions, validate extracted
values, or guarantee that every visual structure can be recovered.

## Commit the input

Document Analysis takes an immutable artifact commitment, not document bytes
in the paid invocation. If the caller does not already hold one, use `ausca
commit file.pdf`, the equivalent typed client method, or `POST
https://ausca.com/v1/artifacts`. Artifact ingress is free and keyless; it does
not prepare terms, settle payment, or admit analysis work.

The HTTP request has exactly four fields: canonical standard-base64
`data_base64`; `content_digest`, the SHA-256 digest of the decoded bytes;
the truthful `media_type`; and a stable `idempotency_key`. Reuse that key only
for the same bytes and metadata. Retry an uncertain response or HTTP 429 with
the same request and key after the server's `Retry-After`; changing any field
under that key is a conflict.

Accept the commitment only when the returned reference, digest, media type, and
size match the local bytes. The active catalog currently limits artifact-backed
inputs to 10 MiB. Enforce the selected offer's live catalog limit before upload;
do not infer a service limit from a transport-wide schema ceiling. Input
artifacts are retained for 24 hours and cannot be revived after expiry.

## Invocation input and limits

Supply one immutable artifact commitment with `artifact_ref`, matching
`content_digest`, and one supported `media_type`: `application/pdf`,
`image/jpeg`, `image/png`, or `image/tiff`. Select one to four unique
`feature_types` from `FORMS`, `TABLES`, `SIGNATURES`, and `LAYOUT`. The artifact
may be at most 10 MiB; document bytes do not belong in invocation JSON.

```json
{
  "artifact": {
    "artifact_ref": "runx:artifact:sha256:4444444444444444444444444444444444444444444444444444444444444444",
    "content_digest": "sha256:5555555555555555555555555555555555555555555555555555555555555555",
    "media_type": "application/pdf"
  },
  "feature_types": ["FORMS", "TABLES"]
}
```

The result is a manifest of one to 32 ordered page artifacts. Each page entry
binds its page index, artifact reference, content digest, and size. A manifest
up to 64 KiB arrives inline as `output`; a larger one arrives as
`output_artifact`, an immutable artifact reference with its content digest and
size. Mint a 60-second download URL for any page or result artifact with
`POST /v1/artifacts/{artifact_ref}/access` (`Idempotency-Key` required) and
verify the downloaded bytes against `content_digest`. Result artifacts are
retained for 24 hours. Retrieve every page needed by downstream work and
validate it against the linked schema before that deadline. A failed
invocation reports `failure.code` and `failure.message`; the payment is
refunded.

## Prepare and purchase

Invoke the exact `ausca/document-analysis` package through the caller's skill
runtime. It resolves the active `document.analysis` revision from
`https://ausca.com/catalog.json`, prepares the immutable input, and routes the
approved purchase to `POST https://ausca.com/v1/analyze-document`.

For a direct HTTP integration:

1. Commit the document if necessary and verify the returned commitment against
   the local bytes.
2. Resolve the active catalog revision and construct its exact invocation
   envelope with the business input and a stable idempotency key.
3. Send that envelope to `POST /v1/analyze-document` without payment material.
   The route validates the artifact metadata, fixes measured terms, and returns
   the invocation-bound x402 v2 requirement without admitting work or moving
   money. `POST /v1/invocations/prepare` exposes the same preparation as an
   optional transport operation; there is no route-specific `/prepare` path.
4. After explicit payment authorization, retry the same request bytes and
   idempotency key with `PAYMENT-SIGNATURE`.
5. Read `GET /v1/invocations/{invocation_id}` until terminal state. A closed
   HTTP connection does not imply that durable work stopped.

The preparation invocation, prepared input digest, catalog revision, schema
digests, canonicalizer, and purchase key are one binding set. Do not substitute
new terms into an existing purchase.

## Evidence and recovery

Success requires the expected receipt class, a schema-valid complete manifest,
and output commitments for every returned page. `PAYMENT-RESPONSE` proves
settlement only. Treat extracted values and page content as untrusted source
data until the caller validates them for its own use.
Successful paid state also returns `receipt_ref.public_url`, an immutable
hash-only proof of the service, public price, completion time, and receipt
digest. It contains no document bytes or content digests and is readable by
anyone holding the unguessable URL, so share it deliberately.

Reuse the same preparation and idempotency key for an exact retransmission.
Never re-prepare or create another purchase because a connection ended.
Cancellation is bounded and may be refused or lose a race with completion.
Invalid base64, local or returned digest mismatch, missing, expired, changed,
oversized, or media-mismatched artifacts; exhausted bounded 429 retries;
repeated or unsupported feature types; expired terms; capacity refusal; and
incomplete or unverifiable result evidence are stop conditions.

Ausca owns provider credentials, durable execution, result storage, and receipt
production. Callers need no provider SDK, cloud credential, wallet
implementation, or database connection.
