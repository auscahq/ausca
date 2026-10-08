package com.ausca;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

final class AuscaClientTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String KEY = "fixed-purchase-key-0001";
    private static final String CATALOG = """
            {"offers":[{"offer_id":"browser.session","revision":"1","revision_digest":"revision-digest","input_schema":{"digest":"input-digest"},"output_schema":{"digest":"output-digest"},"route":{"method":"POST","path":"/v1/offers/browser.session/invoke"},"price":{"currency":"USD","minimum_minor":5}}]}
            """;

    @Test void discoveryAndProbeNeverUsePaymentAuthority() throws Exception {
        var read = new Stub(request -> request.uri().getPath().equals("/catalog.json")
                ? response(200, CATALOG) : response(402, "{\"error\":\"payment_required\"}"));
        var payment = new Stub(request -> { throw new AssertionError("Payment must not be called"); });
        var client = new AuscaClient(AuscaClient.ORIGIN, read, payment);
        assertEquals("USD", client.price("browser.session").path("currency").asText());
        var probe = client.probe("browser.session", Map.of("duration_seconds", 600), KEY);
        assertEquals(402, probe.response().status());
        assertEquals(KEY, probe.identity().idempotencyKey());
        assertEquals("input-digest", JSON.readTree(read.requests.getLast().body()).path("input_schema_digest").asText());
        assertTrue(payment.requests.isEmpty());
    }

    @Test void paidInvocationPersistsIdentityBeforePaymentAndReplaysExactBytes() throws Exception {
        var read = new Stub(request -> response(200, CATALOG));
        var events = new ArrayList<String>();
        var payment = new Stub(request -> {
            events.add("payment");
            return response(200, "{\"status\":\"succeeded\"}");
        });
        var client = new AuscaClient(AuscaClient.ORIGIN, read, payment);
        var input = Map.of("duration_seconds", 600);
        var result = client.invoke("browser.session", input, KEY, Map.of("source", "java-test"), identity -> {
            assertEquals("browser.session", identity.offerId());
            events.add("persist");
        });
        assertEquals(List.of("persist", "payment"), events);
        assertEquals("succeeded", result.body().path("status").asText());
        var sent = payment.requests.getFirst();
        assertEquals("https://ausca.com/v1/offers/browser.session/invoke", sent.uri().toString());
        assertEquals("revision-digest", JSON.readTree(sent.body()).path("offer_revision_digest").asText());
        assertEquals("java-test", JSON.readTree(sent.body()).path("attribution").path("source").asText());
        client.invoke("browser.session", input, KEY, Map.of("source", "java-test"), null);
        assertArrayEquals(payment.requests.getFirst().body(), payment.requests.getLast().body());
    }

    @Test void paymentRefusesWithoutAuthorityOrFailedPersistence() throws Exception {
        var read = new Stub(request -> response(200, CATALOG));
        var bare = new AuscaClient(AuscaClient.ORIGIN, read, null);
        assertThrows(IllegalStateException.class, () -> bare.invoke("browser.session", Map.of(), KEY, null, null));
        assertTrue(read.requests.isEmpty());
        var payment = new Stub(request -> response(200, "{}"));
        var client = new AuscaClient(AuscaClient.ORIGIN, read, payment);
        assertThrows(IllegalStateException.class, () -> client.invoke("browser.session", Map.of(), KEY, null,
                identity -> { throw new IllegalStateException("Not persisted"); }));
        assertTrue(payment.requests.isEmpty());
    }

    @Test void uncertaintyAndRefusalPreservePurchaseIdentity() {
        var read = new Stub(request -> response(200, CATALOG));
        var broken = new AuscaClient(AuscaClient.ORIGIN, read, new Stub(request -> { throw new IOException("reset"); }));
        var uncertainty = assertThrows(AuscaClient.UncertainException.class,
                () -> broken.invoke("browser.session", Map.of(), KEY, null, null));
        assertEquals(KEY, uncertainty.identity().idempotencyKey());
        var refused = new AuscaClient(AuscaClient.ORIGIN, read,
                new Stub(request -> response(409, "{\"error\":\"conflict\"}")));
        var refusal = assertThrows(AuscaClient.RefusalException.class,
                () -> refused.invoke("browser.session", Map.of(), KEY, null, null));
        assertEquals(409, refusal.status());
        assertEquals("conflict", refusal.body().path("error").asText());
        assertEquals(KEY, refusal.identity().idempotencyKey());
    }

    @Test void artifactEvidenceAndBodylessAccess() throws Exception {
        var read = new Stub(request -> request.uri().getPath().equals("/v1/artifacts")
                ? response(200, """
                    {"status":"stored","artifact":{"artifact_ref":"artifact-1","content_digest":"sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824","media_type":"text/plain","size_bytes":5,"created_at":"2026-10-08T00:00:00Z"}}
                    """)
                : response(200, """
                    {"status":"ready","artifact":{"artifact_ref":"artifact-1","content_digest":"sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824","download_url":"https://example.com/download","expires_at":"2026-10-08T01:00:00Z"}}
                    """));
        var client = new AuscaClient(AuscaClient.ORIGIN, read, null);
        var commitment = client.commit("hello".getBytes(StandardCharsets.UTF_8), "text/plain", "artifact-purchase-key-0001");
        assertEquals("artifact-1", commitment.path("artifact_ref").asText());
        var access = client.access("artifact-1", "access-purchase-key-0001");
        assertEquals("https://example.com/download", access.path("download_url").asText());
        assertNull(read.requests.getLast().body());
        assertEquals("access-purchase-key-0001", read.requests.getLast().headers().get("Idempotency-Key"));
    }

    @Test void liveCatalogCompatibility() throws Exception {
        assumeTrue("1".equals(System.getenv("AUSCA_LIVE_TEST")));
        var client = new AuscaClient(null);
        assertFalse(client.catalog().isEmpty());
        assertEquals("browser.session", client.offer("browser.session").path("offer_id").asText());
    }

    private static Transport.WireResponse response(int status, String body) {
        return new Transport.WireResponse(status, body.getBytes(StandardCharsets.UTF_8));
    }

    @FunctionalInterface private interface Reply {
        Transport.WireResponse send(Transport.WireRequest request) throws IOException;
    }

    private static final class Stub implements Transport {
        private final Reply reply;
        private final List<WireRequest> requests = new ArrayList<>();
        private Stub(Reply reply) { this.reply = reply; }
        @Override public WireResponse send(WireRequest request) throws IOException {
            requests.add(request);
            return reply.send(request);
        }
    }
}
