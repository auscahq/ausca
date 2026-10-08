# Ausca for .NET

[Ausca](https://ausca.com) is pay-per-call infrastructure for agents. This
client reads the [live catalog](https://ausca.com/catalog.json) and binds
exact offer revisions without embedding prices, schemas, payment rails, or
credentials.

```csharp
var client = new AuscaClient(payment: myPaymentAuthority);
var offer = await client.OfferAsync("browser.session"); // free catalog read
var result = await client.InvokeAsync(
    "browser.session", new { duration_seconds = 600 },
    idempotencyKey: savedPurchaseKey,
    beforePayment: identity => PersistIdentityAsync(identity));
Console.WriteLine(result.Body);
```

`myPaymentAuthority` implements `ITransport.SendAsync(WireRequest)` and owns
402 challenge handling, exact-byte replay, signing and a caller-selected
spend cap. The default read transport never receives credentials. Without a
payment authority, `InvokeAsync` refuses before sending a paid request.
`ProbeAsync` inspects a challenge without paying. On an uncertain response,
reuse the same input and idempotency key; a new key starts a new purchase.

`CommitAsync` uploads immutable input bytes, `AccessAsync` mints bodyless
short-lived download access, and `InvocationAsync` reads state without
payment. The [agent contract](https://ausca.com/SKILL.md) explains the
service-specific lifecycle and limits.
