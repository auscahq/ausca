// Release gate for the small handwritten transport kernels. Offer facts are
// always read from the live catalog; this checks the stable wire skeleton that
// every language emits against the published OpenAPI projection.
import assert from "node:assert/strict";

const origin = process.env.AUSCA_CONTRACT_ORIGIN ?? "https://ausca.com";
const load = async (path) => {
  const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, `${path} answered ${response.status}`);
  return response.json();
};

const [openapi, catalog] = await Promise.all([
  load("/openapi.json"),
  load("/catalog.json"),
]);
const required = [
  "offer_id", "offer_revision", "offer_revision_digest", "input_schema_digest",
  "output_schema_digest", "input", "idempotency_key",
].sort();
const envelope = openapi.components.schemas.InvocationEnvelope;
assert.deepEqual([...envelope.required].sort(), required);
assert.equal(envelope.additionalProperties, false);
assert.equal(envelope.properties.idempotency_key.minLength, 16);
assert.equal(envelope.properties.idempotency_key.maxLength, 128);
assert.deepEqual([...envelope.properties.attribution.required].sort(), ["source"]);
assert.equal(envelope.properties.attribution.additionalProperties, false);
assert.equal(openapi.paths["/v1/artifacts/{artifact_ref}/access"].post.requestBody, undefined);

assert.ok(Array.isArray(catalog.offers) && catalog.offers.length > 0, "empty offer catalog");
for (const offer of catalog.offers) {
  assert.equal(offer.route.method, "POST", `${offer.offer_id} route method changed`);
  const operation = openapi.paths[offer.route.path]?.post;
  assert.ok(operation, `${offer.offer_id} route is missing from OpenAPI`);
  const request = operation.requestBody?.content?.["application/json"]?.schema;
  assert.deepEqual([...request.required].sort(), required, `${offer.offer_id} request shape changed`);
  assert.equal(request.additionalProperties, false);
  for (const field of ["revision_digest", "input_schema", "output_schema", "price"]) {
    assert.ok(offer[field], `${offer.offer_id} has no ${field} binding`);
  }
}
process.stdout.write(`wire authority verified for ${catalog.offers.length} live offers\n`);
