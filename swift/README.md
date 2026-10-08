# Ausca for Swift

Add `https://github.com/auscahq/ausca` as a Swift Package dependency and
import `Ausca`. This is a small buyer client for the live
[Ausca catalog](https://ausca.com/catalog.json), not a copy of its prices,
routes, revisions, or schemas.

```swift
let client = AuscaClient(payment: myPaymentTransport)
let offer = try await client.offer("browser.session") // free catalog read
print(offer.price.currency)

let result = try await client.invoke(
    "browser.session",
    input: ["duration_seconds": 600],
    idempotencyKey: "my-browser-purchase-0001",
    beforePayment: { identity in try await persistIdentity(identity) }
)
print(String(decoding: result.body, as: UTF8.self))
```

`Transport` is the payment authority port. It handles 402 challenges,
signatures, exact request replay, and a hard per-call cap. The default read
transport holds no wallet material. `probe` inspects without paying.
`AuscaError.uncertain` preserves the identity for recovery with the same input
and key; a new key is a new purchase. `commit` uses keyless artifact ingress,
and `access` mints bodyless short-lived download access. Verify downloaded
bytes against the returned digest. The live catalog controls offer-specific
limits.
