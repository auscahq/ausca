using System.Net.Http.Headers;

namespace Ausca;

/// <summary>Immutable wire bytes; a payment authority must replay them exactly.</summary>
public sealed class WireRequest
{
    private readonly byte[]? _body;

    public WireRequest(string method, Uri uri, byte[]? body = null,
        IReadOnlyDictionary<string, string>? headers = null)
    {
        Method = method;
        Uri = uri;
        _body = body?.ToArray();
        Headers = new System.Collections.ObjectModel.ReadOnlyDictionary<string, string>(
            new Dictionary<string, string>(headers ?? new Dictionary<string, string>()));
    }

    public string Method { get; }
    public Uri Uri { get; }
    public byte[]? Body => _body?.ToArray();
    public IReadOnlyDictionary<string, string> Headers { get; }
}

public sealed class WireResponse
{
    private readonly byte[] _body;

    public WireResponse(int status, byte[] body)
    {
        Status = status;
        _body = body.ToArray();
    }

    public int Status { get; }
    public byte[] Body => _body.ToArray();
}

/// <summary>Payment boundary; implementation owns credentials, caps and 402 retry.</summary>
public interface ITransport
{
    Task<WireResponse> SendAsync(WireRequest request, CancellationToken cancellationToken = default);
}

/// <summary>Credential-free transport for discovery, inspection and state reads.</summary>
public sealed class HttpTransport : ITransport
{
    private static readonly HttpClient SharedClient = new();
    private readonly HttpClient _client;

    public HttpTransport(HttpClient? client = null) => _client = client ?? SharedClient;

    public async Task<WireResponse> SendAsync(WireRequest request,
        CancellationToken cancellationToken = default)
    {
        using var outgoing = new HttpRequestMessage(new HttpMethod(request.Method), request.Uri);
        var body = request.Body;
        if (body is not null) outgoing.Content = new ByteArrayContent(body);
        foreach (var (name, value) in request.Headers)
        {
            if (name.Equals("Content-Type", StringComparison.OrdinalIgnoreCase))
            {
                if (outgoing.Content is null) throw new ArgumentException("Bodyless request cannot have Content-Type");
                outgoing.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(value);
            }
            else if (!outgoing.Headers.TryAddWithoutValidation(name, value))
            {
                throw new ArgumentException($"Invalid request header {name}");
            }
        }
        using var response = await _client.SendAsync(outgoing,
            HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        return new WireResponse((int)response.StatusCode,
            await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false));
    }
}
