# Ausca for Rust

The `ausca` crate is a small buyer client for the live
[Ausca catalog](https://ausca.com/catalog.json). It resolves active offer
revisions and schemas, builds exact paid invocation envelopes, and preserves
recovery identity. Prices, routes, and contract digests are never pinned here.

```rust
use std::sync::Arc;
use ausca::{Client, InvokeOptions, Transport};

// Implement Transport for an x402-capable client that enforces your spend cap.
let payment: Arc<dyn Transport> = Arc::new(my_payment_authority);
let client = Client::new(Some(payment));
let offer = client.offer("browser.session")?; // free catalog read
println!("{}", offer.price.currency);

let result = client.invoke(
    "browser.session",
    serde_json::json!({"duration_seconds": 600}),
    InvokeOptions { idempotency_key: Some("my-browser-purchase-0001".into()), ..Default::default() },
)?;
println!("{}", result.body);
```

The `Transport` port receives immutable `Request` bytes; the payment authority
owns 402 handling, signing, and a hard per-call cap. The default read transport
never holds wallet material. `probe` inspects a challenge without paying.
`Error::Uncertain` carries the purchase identity: retry only with the same
input and key. `Error::Refusal` carries status, body, and identity. Pass a
`before_payment` callback to durably retain identity before the paid request.

`commit` uses keyless artifact ingress; `access` mints bodyless short-lived
download access. The live offer catalog controls offer-specific limits. Verify
downloaded bytes against the returned digest.

```sh
cargo test
cargo publish --dry-run
```
