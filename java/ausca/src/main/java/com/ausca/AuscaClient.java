package com.ausca;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/** Catalog-bound buyer operations. Only the payment transport may authorize spend. */
public final class AuscaClient {
    public static final String ORIGIN = "https://ausca.com";
    public static final int MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Pattern LABEL = Pattern.compile("^[a-z0-9][a-z0-9._-]*$");

    public record Identity(String offerId, String idempotencyKey) { }
    public record Envelope(byte[] body, Identity identity) {
        public Envelope { body = body.clone(); }
        @Override public byte[] body() { return body.clone(); }
    }
    public record Result(int status, JsonNode body, Identity identity) { }
    public record Probe(Transport.WireResponse response, Identity identity) { }

    public static final class RefusalException extends RuntimeException {
        private final int status;
        private final JsonNode body;
        private final Identity identity;
        public RefusalException(int status, JsonNode body, Identity identity) {
            super("Ausca refused purchase with HTTP " + status);
            this.status = status;
            this.body = body;
            this.identity = identity;
        }
        public int status() { return status; }
        public JsonNode body() { return body; }
        public Identity identity() { return identity; }
    }

    public static final class UncertainException extends RuntimeException {
        private final Identity identity;
        public UncertainException(Identity identity, Throwable cause) {
            super("Ausca outcome uncertain; recover with the same input and " + identity.idempotencyKey(), cause);
            this.identity = identity;
        }
        public Identity identity() { return identity; }
    }

    private final URI origin;
    private final Transport read;
    private final Transport payment;
    private volatile String catalogSource;

    public AuscaClient(Transport payment) { this(ORIGIN, new HttpTransport(), payment); }
    public AuscaClient(String origin, Transport read, Transport payment) {
        this.origin = URI.create(origin.replaceAll("/+$", "") + "/");
        this.read = Objects.requireNonNull(read);
        this.payment = payment;
    }

    public List<JsonNode> catalog() throws IOException, InterruptedException {
        var source = catalogSource;
        if (source == null) return refreshCatalog();
        return parseCatalog(source);
    }

    public List<JsonNode> refreshCatalog() throws IOException, InterruptedException {
        var response = request(read, "GET", "/catalog.json", null, Map.of());
        if (response.status() != 200) throw new IOException("Catalog answered " + response.status());
        var source = new String(response.body(), StandardCharsets.UTF_8);
        var offers = parseCatalog(source);
        catalogSource = source;
        return offers;
    }

    public JsonNode offer(String offerId) throws IOException, InterruptedException {
        for (var offer : catalog()) if (offer.path("offer_id").asText().equals(offerId)) return offer;
        throw new IllegalArgumentException("Offer " + offerId + " is not active in the catalog");
    }

    public JsonNode price(String offerId) throws IOException, InterruptedException {
        return offer(offerId).path("price").deepCopy();
    }

    public Envelope envelope(JsonNode offer, Object input, String idempotencyKey, Map<String, String> attribution) {
        validateOffer(offer);
        var key = idempotencyKey == null ? newKey("ausca-") : idempotencyKey;
        validateKey(key);
        if (attribution != null) validateAttribution(attribution);
        var body = JSON.createObjectNode();
        body.put("offer_id", offer.path("offer_id").asText());
        body.put("offer_revision", offer.path("revision").asText());
        body.put("offer_revision_digest", offer.path("revision_digest").asText());
        body.put("input_schema_digest", offer.path("input_schema").path("digest").asText());
        body.put("output_schema_digest", offer.path("output_schema").path("digest").asText());
        body.set("input", JSON.valueToTree(input));
        body.put("idempotency_key", key);
        if (attribution != null) body.set("attribution", JSON.valueToTree(attribution));
        try {
            return new Envelope(JSON.writeValueAsBytes(body), new Identity(offer.path("offer_id").asText(), key));
        } catch (IOException error) {
            throw new IllegalArgumentException("Input cannot be serialized", error);
        }
    }

    public Probe probe(String offerId, Object input, String idempotencyKey) throws IOException, InterruptedException {
        var offer = offer(offerId);
        var envelope = envelope(offer, input, idempotencyKey, null);
        var response = request(read, "POST", offer.path("route").path("path").asText(), envelope.body(), Map.of());
        return new Probe(response, envelope.identity());
    }

    public Result invoke(String offerId, Object input, String idempotencyKey,
                         Map<String, String> attribution, Consumer<Identity> beforePayment)
            throws IOException, InterruptedException {
        if (payment == null) throw new IllegalStateException("Payment authority is required for invoke");
        var offer = offer(offerId);
        var envelope = envelope(offer, input, idempotencyKey, attribution);
        if (beforePayment != null) beforePayment.accept(envelope.identity());
        Transport.WireResponse response;
        try {
            response = request(payment, "POST", offer.path("route").path("path").asText(), envelope.body(), Map.of());
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new UncertainException(envelope.identity(), error);
        } catch (IOException | RuntimeException error) {
            throw new UncertainException(envelope.identity(), error);
        }
        JsonNode body;
        try {
            body = parseObject(response.body());
        } catch (IOException error) {
            throw new UncertainException(envelope.identity(), error);
        }
        if (response.status() >= 400) throw new RefusalException(response.status(), body, envelope.identity());
        return new Result(response.status(), body, envelope.identity());
    }

    public JsonNode invocation(String invocationId) throws IOException, InterruptedException {
        if (invocationId == null || invocationId.isEmpty()) throw new IllegalArgumentException("Invocation ID is required");
        var response = request(read, "GET", "/v1/invocations/" + encodePath(invocationId), null, Map.of());
        if (response.status() != 200) throw new IOException("Invocation answered " + response.status());
        return parseObject(response.body());
    }

    public JsonNode commit(byte[] bytes, String mediaType, String idempotencyKey) throws IOException, InterruptedException {
        if (bytes == null || bytes.length < 1 || bytes.length > MAX_ARTIFACT_BYTES)
            throw new IllegalArgumentException("Outside artifact ingress limit");
        if (mediaType == null || mediaType.isEmpty() || mediaType.length() > 200 || !mediaType.trim().equals(mediaType))
            throw new IllegalArgumentException("Invalid media type");
        var key = idempotencyKey == null ? newKey("ausca-artifact-") : idempotencyKey;
        validateKey(key);
        var digest = "sha256:" + sha256(bytes);
        var body = JSON.createObjectNode();
        body.put("data_base64", Base64.getEncoder().encodeToString(bytes));
        body.put("content_digest", digest);
        body.put("media_type", mediaType);
        body.put("idempotency_key", key);
        Transport.WireResponse response;
        try {
            response = request(read, "POST", "/v1/artifacts", JSON.writeValueAsBytes(body), Map.of());
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("Artifact commit uncertain; reuse key " + key, error);
        } catch (IOException error) {
            throw new IOException("Artifact commit uncertain; reuse key " + key, error);
        }
        if (response.status() != 200) throw new IOException("Artifact ingress answered " + response.status() + "; reuse key " + key);
        JsonNode result;
        try {
            result = parseObject(response.body());
        } catch (IOException error) {
            throw new IOException("Artifact commit uncertain; reuse key " + key, error);
        }
        var artifact = result.path("artifact");
        if (!result.path("status").asText().equals("stored") ||
            artifact.path("artifact_ref").asText().isEmpty() || artifact.path("artifact_ref").asText().length() > 512 ||
            !artifact.path("content_digest").asText().equals(digest) ||
            !artifact.path("media_type").asText().equals(mediaType) ||
            artifact.path("size_bytes").asInt(-1) != bytes.length || artifact.path("created_at").asText().isEmpty())
            throw new IOException("Artifact ingress returned mismatched evidence; reuse key " + key);
        var commitment = JSON.createObjectNode();
        commitment.put("artifact_ref", artifact.path("artifact_ref").asText());
        commitment.put("content_digest", digest);
        commitment.put("media_type", mediaType);
        return commitment;
    }

    public JsonNode access(String artifactRef, String idempotencyKey) throws IOException, InterruptedException {
        if (artifactRef == null || artifactRef.isEmpty() || artifactRef.length() > 512)
            throw new IllegalArgumentException("Invalid artifact reference");
        var key = idempotencyKey == null ? newKey("ausca-") : idempotencyKey;
        validateKey(key);
        var response = request(read, "POST", "/v1/artifacts/" + encodePath(artifactRef) + "/access", null,
                Map.of("Idempotency-Key", key));
        if (response.status() != 200) throw new IOException("Artifact access answered " + response.status());
        var result = parseObject(response.body());
        var artifact = result.path("artifact");
        if (!result.path("status").asText().equals("ready") ||
            !artifact.path("artifact_ref").asText().equals(artifactRef) ||
            artifact.path("content_digest").asText().isEmpty() ||
            artifact.path("download_url").asText().isEmpty() || artifact.path("expires_at").asText().isEmpty())
            throw new IOException("Artifact access returned invalid evidence");
        return artifact.deepCopy();
    }

    private Transport.WireResponse request(Transport transport, String method, String path, byte[] body,
                                           Map<String, String> headers) throws IOException, InterruptedException {
        if (!path.startsWith("/") || path.startsWith("//") || path.contains("..") ||
            path.contains("?") || path.contains("#")) throw new IllegalArgumentException("Invalid resource path");
        var allHeaders = new java.util.LinkedHashMap<>(headers);
        if (body != null) allHeaders.put("Content-Type", "application/json");
        return transport.send(new Transport.WireRequest(method, origin.resolve(path), body, allHeaders));
    }

    private static List<JsonNode> parseCatalog(String source) throws IOException {
        var root = JSON.readTree(source);
        if (root == null || !root.isObject()) throw new IOException("Invalid catalog document");
        var offers = root.path("offers");
        if (!offers.isArray()) throw new IOException("Catalog has no offers");
        var result = new ArrayList<JsonNode>();
        for (var offer : offers) {
            validateOffer(offer);
            result.add(offer.deepCopy());
        }
        return result;
    }

    private static JsonNode parseObject(byte[] body) throws IOException {
        var node = JSON.readTree(body);
        if (node == null || !node.isObject()) throw new IOException("Expected JSON object");
        return node;
    }

    private static void validateOffer(JsonNode offer) {
        for (var name : List.of("offer_id", "revision", "revision_digest"))
            if (!offer.path(name).isTextual() || offer.path(name).asText().isEmpty())
                throw new IllegalArgumentException("Invalid catalog offer binding");
        for (var name : List.of("input_schema", "output_schema"))
            if (!offer.path(name).path("digest").isTextual() || offer.path(name).path("digest").asText().isEmpty())
                throw new IllegalArgumentException("Invalid catalog offer binding");
        var route = offer.path("route");
        var path = route.path("path").asText();
        if (!route.path("method").asText().equals("POST") || !path.startsWith("/v1/") ||
            path.contains("..") || path.contains("?") || path.contains("#"))
            throw new IllegalArgumentException("Invalid catalog offer binding");
    }

    private static void validateKey(String key) {
        var size = key.getBytes(StandardCharsets.UTF_8).length;
        if (size < 16 || size > 128 || !key.trim().equals(key) || key.codePoints().anyMatch(Character::isISOControl))
            throw new IllegalArgumentException("Idempotency key must be 16 to 128 clean UTF-8 bytes");
    }

    private static void validateAttribution(Map<String, String> attribution) {
        if (!attribution.keySet().stream().allMatch(key -> key.equals("source") || key.equals("campaign")) ||
            !attribution.containsKey("source") || !validLabel(attribution.get("source"), 64) ||
            (attribution.containsKey("campaign") && !validLabel(attribution.get("campaign"), 128)))
            throw new IllegalArgumentException("Invalid attribution source or campaign");
    }

    private static boolean validLabel(String value, int max) {
        return value != null && value.length() <= max && LABEL.matcher(value).matches();
    }

    private static String newKey(String prefix) {
        var bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        return prefix + HexFormat.of().formatHex(bytes);
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 unavailable", error);
        }
    }

    private static String encodePath(String value) {
        return java.net.URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }
}
