using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Ausca;

public sealed record PurchaseIdentity(string OfferId, string IdempotencyKey);
public sealed record InvocationResult(int Status, JsonElement Body, PurchaseIdentity Identity);
public sealed record ProbeResult(WireResponse Response, PurchaseIdentity Identity);

public sealed class RefusalException : Exception
{
    public RefusalException(int status, JsonElement body, PurchaseIdentity identity)
        : base($"Ausca refused purchase with HTTP {status}")
    {
        Status = status;
        Body = body;
        Identity = identity;
    }

    public int Status { get; }
    public JsonElement Body { get; }
    public PurchaseIdentity Identity { get; }
}

public sealed class UncertainException : Exception
{
    public UncertainException(PurchaseIdentity identity, Exception cause)
        : base($"Ausca outcome uncertain; recover with the same input and {identity.IdempotencyKey}", cause)
        => Identity = identity;

    public PurchaseIdentity Identity { get; }
}

/// <summary>Catalog-bound buyer client. Only its payment port can authorize spend.</summary>
public sealed class AuscaClient
{
    public const string Origin = "https://ausca.com";
    public const int MaxArtifactBytes = 25 * 1024 * 1024;
    private static readonly Regex LabelPattern = new("^[a-z0-9][a-z0-9._-]*$", RegexOptions.CultureInvariant);

    private readonly ITransport _read;
    private readonly ITransport? _payment;
    private readonly Uri _origin;
    private string? _catalogSource;

    public AuscaClient(ITransport? payment = null, ITransport? read = null, string origin = Origin)
    {
        _payment = payment;
        _read = read ?? new HttpTransport();
        _origin = new Uri(origin.TrimEnd('/') + "/", UriKind.Absolute);
    }

    public async Task<IReadOnlyList<JsonElement>> CatalogAsync(bool refresh = false,
        CancellationToken cancellationToken = default)
    {
        if (_catalogSource is null || refresh)
        {
            var response = await RequestAsync(_read, "GET", "/catalog.json", cancellationToken: cancellationToken);
            if (response.Status != 200) throw new InvalidOperationException($"Catalog answered {response.Status}");
            var source = Encoding.UTF8.GetString(response.Body);
            var offers = ParseCatalog(source);
            _catalogSource = source;
            return offers;
        }
        return ParseCatalog(_catalogSource);
    }

    public async Task<JsonElement> OfferAsync(string offerId, CancellationToken cancellationToken = default)
    {
        foreach (var offer in await CatalogAsync(cancellationToken: cancellationToken))
        {
            if (offer.GetProperty("offer_id").GetString() == offerId) return offer;
        }
        throw new ArgumentException($"Offer {offerId} is not active in the catalog", nameof(offerId));
    }

    public async Task<JsonElement> PriceAsync(string offerId, CancellationToken cancellationToken = default) =>
        (await OfferAsync(offerId, cancellationToken)).GetProperty("price").Clone();

    public (byte[] Body, PurchaseIdentity Identity) Envelope(JsonElement offer, object? input, string? idempotencyKey = null,
        IReadOnlyDictionary<string, string>? attribution = null)
    {
        ValidateOffer(offer);
        var key = idempotencyKey ?? NewKey("ausca-");
        ValidateKey(key);
        if (attribution is not null) ValidateAttribution(attribution);
        var body = new Dictionary<string, object?>
        {
            ["offer_id"] = offer.GetProperty("offer_id").GetString(),
            ["offer_revision"] = offer.GetProperty("revision").GetString(),
            ["offer_revision_digest"] = offer.GetProperty("revision_digest").GetString(),
            ["input_schema_digest"] = offer.GetProperty("input_schema").GetProperty("digest").GetString(),
            ["output_schema_digest"] = offer.GetProperty("output_schema").GetProperty("digest").GetString(),
            ["input"] = input,
            ["idempotency_key"] = key,
        };
        if (attribution is not null) body["attribution"] = attribution;
        return (JsonSerializer.SerializeToUtf8Bytes(body),
            new PurchaseIdentity(offer.GetProperty("offer_id").GetString()!, key));
    }

    public async Task<ProbeResult> ProbeAsync(string offerId, object? input,
        string? idempotencyKey = null, CancellationToken cancellationToken = default)
    {
        var offer = await OfferAsync(offerId, cancellationToken);
        var (body, identity) = Envelope(offer, input, idempotencyKey);
        var response = await RequestAsync(_read, "POST", offer.GetProperty("route").GetProperty("path").GetString()!,
            body, cancellationToken: cancellationToken);
        return new ProbeResult(response, identity);
    }

    public async Task<InvocationResult> InvokeAsync(string offerId, object? input,
        string? idempotencyKey = null, IReadOnlyDictionary<string, string>? attribution = null,
        Func<PurchaseIdentity, Task>? beforePayment = null, CancellationToken cancellationToken = default)
    {
        if (_payment is null) throw new InvalidOperationException("Payment authority is required for invoke");
        var offer = await OfferAsync(offerId, cancellationToken);
        var (body, identity) = Envelope(offer, input, idempotencyKey, attribution);
        if (beforePayment is not null) await beforePayment(identity);
        WireResponse response;
        try
        {
            response = await RequestAsync(_payment, "POST", offer.GetProperty("route").GetProperty("path").GetString()!,
                body, cancellationToken: cancellationToken);
        }
        catch (Exception error)
        {
            throw new UncertainException(identity, error);
        }
        JsonElement decoded;
        try
        {
            decoded = ParseObject(response.Body);
        }
        catch (Exception error)
        {
            throw new UncertainException(identity, error);
        }
        if (response.Status >= 400) throw new RefusalException(response.Status, decoded, identity);
        return new InvocationResult(response.Status, decoded, identity);
    }

    public async Task<JsonElement> InvocationAsync(string invocationId,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(invocationId)) throw new ArgumentException("Invocation ID is required", nameof(invocationId));
        var response = await RequestAsync(_read, "GET", "/v1/invocations/" + Uri.EscapeDataString(invocationId),
            cancellationToken: cancellationToken);
        if (response.Status != 200) throw new InvalidOperationException($"Invocation answered {response.Status}");
        return ParseObject(response.Body);
    }

    public async Task<IReadOnlyDictionary<string, string>> CommitAsync(byte[] bytes, string mediaType,
        string? idempotencyKey = null, CancellationToken cancellationToken = default)
    {
        if (bytes.Length is < 1 or > MaxArtifactBytes) throw new ArgumentException("Outside artifact ingress limit", nameof(bytes));
        if (string.IsNullOrEmpty(mediaType) || mediaType.Length > 200 || mediaType.Trim() != mediaType)
            throw new ArgumentException("Invalid media type", nameof(mediaType));
        var key = idempotencyKey ?? NewKey("ausca-artifact-");
        ValidateKey(key);
        var digest = "sha256:" + Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var body = JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object>
        {
            ["data_base64"] = Convert.ToBase64String(bytes),
            ["content_digest"] = digest,
            ["media_type"] = mediaType,
            ["idempotency_key"] = key,
        });
        WireResponse response;
        try
        {
            response = await RequestAsync(_read, "POST", "/v1/artifacts", body, cancellationToken: cancellationToken);
        }
        catch (Exception error)
        {
            throw new InvalidOperationException($"Artifact commit uncertain; reuse key {key}", error);
        }
        if (response.Status != 200) throw new InvalidOperationException($"Artifact ingress answered {response.Status}; reuse key {key}");
        JsonElement result;
        try
        {
            result = ParseObject(response.Body);
        }
        catch (Exception error)
        {
            throw new InvalidOperationException($"Artifact commit uncertain; reuse key {key}", error);
        }
        try
        {
            var artifact = result.GetProperty("artifact");
            var artifactRef = artifact.GetProperty("artifact_ref").GetString();
            if (result.GetProperty("status").GetString() != "stored" ||
                artifact.GetProperty("content_digest").GetString() != digest ||
                artifact.GetProperty("media_type").GetString() != mediaType ||
                artifact.GetProperty("size_bytes").GetInt32() != bytes.Length ||
                string.IsNullOrEmpty(artifactRef) || artifactRef.Length > 512 ||
                string.IsNullOrEmpty(artifact.GetProperty("created_at").GetString()))
                throw new FormatException("Mismatched artifact evidence");
            return new Dictionary<string, string>
            {
                ["artifact_ref"] = artifactRef,
                ["content_digest"] = digest,
                ["media_type"] = mediaType,
            };
        }
        catch (Exception error) when (error is FormatException or KeyNotFoundException or InvalidOperationException)
        {
            throw new InvalidOperationException($"Artifact ingress returned mismatched evidence; reuse key {key}", error);
        }
    }

    public async Task<JsonElement> AccessAsync(string artifactRef, string? idempotencyKey = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(artifactRef) || artifactRef.Length > 512)
            throw new ArgumentException("Invalid artifact reference", nameof(artifactRef));
        var key = idempotencyKey ?? NewKey("ausca-");
        ValidateKey(key);
        var response = await RequestAsync(_read, "POST",
            "/v1/artifacts/" + Uri.EscapeDataString(artifactRef) + "/access", headers: new Dictionary<string, string>
            { ["Idempotency-Key"] = key }, cancellationToken: cancellationToken);
        if (response.Status != 200) throw new InvalidOperationException($"Artifact access answered {response.Status}");
        var result = ParseObject(response.Body);
        var artifact = result.GetProperty("artifact");
        if (result.GetProperty("status").GetString() != "ready" ||
            artifact.GetProperty("artifact_ref").GetString() != artifactRef ||
            string.IsNullOrEmpty(artifact.GetProperty("content_digest").GetString()) ||
            string.IsNullOrEmpty(artifact.GetProperty("download_url").GetString()) ||
            string.IsNullOrEmpty(artifact.GetProperty("expires_at").GetString()))
            throw new FormatException("Artifact access returned invalid evidence");
        return artifact.Clone();
    }

    private async Task<WireResponse> RequestAsync(ITransport transport, string method, string path,
        byte[]? body = null, IReadOnlyDictionary<string, string>? headers = null,
        CancellationToken cancellationToken = default)
    {
        if (!path.StartsWith('/') || path.StartsWith("//") || path.Contains("..") || path.Contains('?') || path.Contains('#'))
            throw new ArgumentException("Invalid resource path", nameof(path));
        var allHeaders = new Dictionary<string, string>(headers ?? new Dictionary<string, string>());
        if (body is not null) allHeaders["Content-Type"] = "application/json";
        return await transport.SendAsync(new WireRequest(method, new Uri(_origin, path), body, allHeaders), cancellationToken);
    }

    private static IReadOnlyList<JsonElement> ParseCatalog(string source)
    {
        using var document = JsonDocument.Parse(source);
        var offers = document.RootElement.GetProperty("offers");
        if (offers.ValueKind != JsonValueKind.Array) throw new FormatException("Catalog has no offers");
        var result = new List<JsonElement>();
        foreach (var offer in offers.EnumerateArray())
        {
            ValidateOffer(offer);
            result.Add(offer.Clone());
        }
        return result;
    }

    private static JsonElement ParseObject(byte[] body)
    {
        using var document = JsonDocument.Parse(body);
        if (document.RootElement.ValueKind != JsonValueKind.Object) throw new FormatException("Expected JSON object");
        return document.RootElement.Clone();
    }

    private static void ValidateOffer(JsonElement offer)
    {
        try
        {
            foreach (var name in new[] { "offer_id", "revision", "revision_digest" })
                if (string.IsNullOrEmpty(offer.GetProperty(name).GetString())) throw new FormatException("Invalid catalog offer binding");
            foreach (var name in new[] { "input_schema", "output_schema" })
                if (string.IsNullOrEmpty(offer.GetProperty(name).GetProperty("digest").GetString()))
                    throw new FormatException("Invalid catalog offer binding");
            var route = offer.GetProperty("route");
            var path = route.GetProperty("path").GetString();
            if (route.GetProperty("method").GetString() != "POST" || path is null ||
                !path.StartsWith("/v1/", StringComparison.Ordinal) || path.Contains("..") ||
                path.Contains('?') || path.Contains('#')) throw new FormatException("Invalid catalog offer binding");
        }
        catch (Exception error) when (error is KeyNotFoundException or InvalidOperationException or JsonException)
        {
            throw new FormatException("Invalid catalog offer binding", error);
        }
    }

    private static void ValidateKey(string key)
    {
        var count = Encoding.UTF8.GetByteCount(key);
        if (count is < 16 or > 128 || key.Trim() != key || key.Any(char.IsControl))
            throw new ArgumentException("Idempotency key must be 16 to 128 clean UTF-8 bytes", nameof(key));
    }

    private static void ValidateAttribution(IReadOnlyDictionary<string, string> attribution)
    {
        if (attribution.Keys.Any(key => key is not ("source" or "campaign")) ||
            !attribution.TryGetValue("source", out var source) || source.Length > 64 || !LabelPattern.IsMatch(source) ||
            (attribution.TryGetValue("campaign", out var campaign) &&
                (campaign.Length > 128 || !LabelPattern.IsMatch(campaign))))
            throw new ArgumentException("Invalid attribution source or campaign", nameof(attribution));
    }

    private static string NewKey(string prefix) =>
        prefix + Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
}
