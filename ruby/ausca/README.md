# Ausca for Ruby

This gem resolves the live [Ausca catalog](https://ausca.com/catalog.json),
binds an exact offer revision, and preserves a caller-owned purchase identity
across uncertain HTTP responses. It has no runtime gem dependencies and no
embedded wallet or rail. The paid transport must implement
`call(uri, net_http_request) -> net_http_response`, including its own payment
spend policy and x402 challenge/retry handling.

```ruby
require "ausca"

client = Ausca::Client.new(payment: my_payment_authority)
offer = client.offer("browser.session") # free catalog read
puts offer.fetch("price")

result = client.invoke("browser.session", { duration_seconds: 600 },
                       idempotency_key: "my-browser-purchase-0001") do |identity|
  persist_identity(identity) # must succeed before payment begins
end
puts result.fetch(:body)
```

Use `probe` without payment to inspect a challenge. `Ausca::UncertainError`
contains the purchase identity: recover with the same input and key, not a new
purchase. `Ausca::RefusalError` contains the status, decoded body, and identity.
`invocation` reads durable state without payment. `commit` stores immutable
input bytes through keyless artifact ingress; `access` returns a short-lived
download URL with no HTTP request body. Verify downloaded bytes against the
returned digest.

The live catalog controls price, route, revision, schemas, and offer-specific
limits. This package is only a buyer client; it never owns product contracts.

```sh
ruby -Ilib test/client_test.rb
gem build ausca.gemspec
```
