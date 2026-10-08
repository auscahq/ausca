# Ausca for PHP

`composer require auscahq/ausca` installs a small client for the live
[Ausca catalog](https://ausca.com/catalog.json). The package has no runtime
Composer dependencies. It embeds no offer prices, routes, revisions, schemas,
wallet credentials, or x402 implementation.

```php
use Ausca\Client;

$client = new Client(payment: $myPaymentTransport);
$offer = $client->offer('browser.session'); // free read
$result = $client->invoke(
    'browser.session',
    ['duration_seconds' => 600],
    idempotencyKey: 'my-browser-purchase-0001',
    beforePayment: fn (array $identity) => persistIdentity($identity),
);
```

The payment transport implements `Ausca\Transport::send(Request): Response`.
It receives exact replayable bytes and owns 402 challenge handling, signing,
and the hard spend cap. `probe` bypasses it. `UncertainException` preserves the
purchase identity; retry only with identical input and key. `RefusalException`
includes status, decoded body, and identity. `commit` uploads an immutable
input artifact without payment; `access` uses a bodyless HTTP request to mint
short-lived download access. Verify downloaded bytes against the digest.

The live catalog controls offer-specific artifact limits and pricing.
