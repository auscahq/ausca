using System.Text;
using System.Text.Json;
using Ausca;

const string PurchaseKey = "fixed-purchase-key-0001";
const string Catalog = """
    {"offers":[{"offer_id":"browser.session","revision":"1","revision_digest":"revision-digest","input_schema":{"digest":"input-digest"},"output_schema":{"digest":"output-digest"},"route":{"method":"POST","path":"/v1/offers/browser.session/invoke"},"price":{"currency":"USD","minimum_minor":5}}]}
    """;

var read = new StubTransport(request => Task.FromResult(
    request.Uri.AbsolutePath == "/catalog.json"
        ? Response(200, Catalog)
        : Response(402, """{"error":"payment_required"}""")));
var payment = new StubTransport(_ => throw new Exception("Unexpected payment"));
var client = new AuscaClient(payment, read);
Check((await client.PriceAsync("browser.session")).GetProperty("currency").GetString() == "USD", "price");
var probe = await client.ProbeAsync("browser.session", new { duration_seconds = 600 }, PurchaseKey);
Check(probe.Response.Status == 402 && probe.Identity.IdempotencyKey == PurchaseKey, "probe identity");
Check(payment.Requests.Count == 0, "probe must not use payment authority");
Check(Parse(read.Requests[^1].Body!).GetProperty("input_schema_digest").GetString() == "input-digest", "probe schema binding");

var events = new List<string>();
var paid = new StubTransport(_ =>
{
    events.Add("payment");
    return Task.FromResult(Response(200, """{"status":"succeeded"}"""));
});
var buyer = new AuscaClient(paid, read);
var result = await buyer.InvokeAsync("browser.session", new { duration_seconds = 600 }, PurchaseKey,
    new Dictionary<string, string> { ["source"] = "dotnet-test" },
    identity =>
    {
        Check(identity.OfferId == "browser.session" && identity.IdempotencyKey == PurchaseKey, "persisted identity");
        events.Add("persist");
        return Task.CompletedTask;
    });
Check(events.SequenceEqual(new[] { "persist", "payment" }), "persistence before payment");
Check(result.Body.GetProperty("status").GetString() == "succeeded", "paid result");
Check(paid.Requests.Single().Uri.ToString() == "https://ausca.com/v1/offers/browser.session/invoke", "catalog route");
Check(Parse(paid.Requests.Single().Body!).GetProperty("offer_revision_digest").GetString() == "revision-digest", "revision binding");
Check(Parse(paid.Requests.Single().Body!).GetProperty("attribution").GetProperty("source").GetString() == "dotnet-test", "attribution");

var noAuthority = new AuscaClient(read: read);
await Expect<InvalidOperationException>(() => noAuthority.InvokeAsync("browser.session", new { }));
var beforeCount = paid.Requests.Count;
await Expect<InvalidOperationException>(() => buyer.InvokeAsync("browser.session", new { }, PurchaseKey,
    beforePayment: _ => throw new InvalidOperationException("Persistence failed")));
Check(paid.Requests.Count == beforeCount, "failed persistence cannot contact payment");

var broken = new AuscaClient(new StubTransport(_ => throw new IOException("reset")), read);
var uncertainty = await Expect<UncertainException>(() => broken.InvokeAsync("browser.session", new { }, PurchaseKey));
Check(uncertainty.Identity.IdempotencyKey == PurchaseKey, "uncertainty identity");
var refused = new AuscaClient(new StubTransport(_ => Task.FromResult(Response(409, """{"error":"conflict"}"""))), read);
var refusal = await Expect<RefusalException>(() => refused.InvokeAsync("browser.session", new { }, PurchaseKey));
Check(refusal.Status == 409 && refusal.Body.GetProperty("error").GetString() == "conflict", "typed refusal");

var artifactRead = new StubTransport(request => Task.FromResult(request.Uri.AbsolutePath == "/v1/artifacts"
    ? Response(200, """
        {"status":"stored","artifact":{"artifact_ref":"artifact-1","content_digest":"sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824","media_type":"text/plain","size_bytes":5,"created_at":"2026-10-08T00:00:00Z"}}
        """)
    : Response(200, """
        {"status":"ready","artifact":{"artifact_ref":"artifact-1","content_digest":"sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824","download_url":"https://example.com/download","expires_at":"2026-10-08T01:00:00Z"}}
        """)));
var artifacts = new AuscaClient(read: artifactRead);
var commitment = await artifacts.CommitAsync(Encoding.UTF8.GetBytes("hello"), "text/plain", "artifact-purchase-key-0001");
Check(commitment["artifact_ref"] == "artifact-1", "artifact commitment");
var access = await artifacts.AccessAsync("artifact-1", "access-purchase-key-0001");
Check(access.GetProperty("download_url").GetString() == "https://example.com/download", "download access");
Check(artifactRead.Requests[^1].Body is null, "access must be bodyless");
Check(artifactRead.Requests[^1].Headers["Idempotency-Key"] == "access-purchase-key-0001", "access key header");

if (Environment.GetEnvironmentVariable("AUSCA_LIVE_TEST") == "1")
{
    var live = new AuscaClient();
    Check((await live.CatalogAsync()).Count > 0, "live catalog");
    Check((await live.OfferAsync("browser.session")).GetProperty("offer_id").GetString() == "browser.session", "live offer");
}

Console.WriteLine("Ausca .NET client tests passed");

static WireResponse Response(int status, string body) => new(status, Encoding.UTF8.GetBytes(body));

static JsonElement Parse(byte[] body)
{
    using var doc = JsonDocument.Parse(body);
    return doc.RootElement.Clone();
}

static void Check(bool condition, string message)
{
    if (!condition) throw new Exception($"Assertion failed: {message}");
}

static async Task<T> Expect<T>(Func<Task> action) where T : Exception
{
    try { await action(); }
    catch (T error) { return error; }
    throw new Exception($"Expected {typeof(T).Name}");
}

internal sealed class StubTransport(Func<WireRequest, Task<WireResponse>> reply) : ITransport
{
    public List<WireRequest> Requests { get; } = [];

    public async Task<WireResponse> SendAsync(WireRequest request, CancellationToken cancellationToken = default)
    {
        Requests.Add(request);
        return await reply(request);
    }
}
