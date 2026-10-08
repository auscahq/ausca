# Ausca for Go

Small buyer client for Ausca's live catalog and paid HTTP resources. The core
uses only the Go standard library. It does not embed offer prices, revisions,
routes, or a payment rail. It resolves the current binding from
[ausca.com/catalog.json](https://ausca.com/catalog.json).

The module path is `github.com/auscahq/ausca/go`. Install the published
module with `go get github.com/auscahq/ausca/go@v0.1.1`.

```go
client := ausca.NewClient(paymentHTTPClient)

offer, err := client.Offer(ctx, "browser.session") // no payment
if err != nil { return err }
fmt.Println(offer.Price)

result, err := client.Invoke(ctx, "browser.session", map[string]any{
    "duration_seconds": 600,
}, ausca.InvokeOptions{
    IdempotencyKey: "my-browser-purchase-0001", // save before paying
    BeforePayment: persistPurchaseIdentity,
})
if err != nil { return err }
fmt.Println(string(result.Body))
```

`paymentHTTPClient` implements `Do(*http.Request) (*http.Response, error)`.
Use an x402-capable `*http.Client` such as the official
[`x402` Go HTTP wrapper](https://github.com/x402-foundation/x402/tree/main/go),
configured with a signer and a hard per-payment spend cap. The same port also
fits future payment rails; signing and credential custody stay outside Ausca's
core. `nil` permits catalog reads, `Probe`, artifact commit/access, and
invocation state reads, but refuses `Invoke` before sending any paid request.

For a purchase: choose and durably save a unique idempotency key. If the
connection closes or the outcome is otherwise uncertain, catch
`*ausca.UncertainError` and retry only with the **same input and key**. A new
key starts another purchase. `*ausca.RefusalError` includes the HTTP status,
typed body, and the same identity. Call `Invocation` for read-only state when
you have an invocation ID. `Probe` returns an ordinary `*http.Response`; the
caller must close its body.

`Commit` uses Ausca's keyless artifact ingress. Its returned commitment is
the `artifact_ref`, `content_digest`, and `media_type` input for document and
media offers. The 25 MiB client ceiling is not an offer limit; consult the
live catalog. `Access` mints a short-lived download URL for a result artifact
without an HTTP request body. Verify downloaded bytes against the commitment.

```sh
go test -race ./...
AUSCA_LIVE_TEST=1 go test -run TestLiveCatalog ./...
```
