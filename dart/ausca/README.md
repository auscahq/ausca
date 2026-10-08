# Ausca for Dart

The [Ausca service](https://ausca.com) provides pay-per-call agent
infrastructure. This package resolves the live
[catalog](https://ausca.com/catalog.json) and builds exact invocation
envelopes; it does not embed prices, offer revisions, schemas, credentials,
or a payment rail.

```dart
final client = AuscaClient(payment: myPaymentAuthority);
final offer = await client.offer('browser.session'); // no payment
print(offer['price']);

final result = await client.invoke(
  'browser.session',
  {'duration_seconds': 600},
  idempotencyKey: savedPurchaseKey,
  beforePayment: (identity) async => persistIdentity(identity),
);
print(result.body);
```

`myPaymentAuthority` implements `Transport.send(WireRequest)` and owns the
402 challenge, signing, exact-byte retry, and a caller-selected spending cap.
Read-only operations use a separate HTTP transport. Without a payment
authority, `invoke` refuses before contacting the paid resource. `probe`
inspects its unsigned challenge without paying.

Save a unique key before payment. On `UncertainException`, recover with the
same input and key; a new key starts a new purchase. `commit` stores an
immutable input artifact, `access` mints bodyless short-lived download access,
and `invocation` reads state without payment. The live catalog determines
offer-specific prices and limits. See [the agent contract](https://ausca.com/SKILL.md)
for full service instructions.
