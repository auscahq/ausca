# Ausca for Java

[Ausca](https://ausca.com) sells pay-per-call agent infrastructure. This
client resolves the live [catalog](https://ausca.com/catalog.json) and binds
the exact offer revision; it does not embed prices, schemas, wallet credentials,
or a payment rail.

```java
var client = new AuscaClient(myPaymentAuthority);
var offer = client.offer("browser.session"); // free catalog read
var result = client.invoke("browser.session", Map.of("duration_seconds", 600),
    savedPurchaseKey, null, identity -> persistIdentity(identity));
System.out.println(result.body());
```

`myPaymentAuthority` implements `Transport.send(WireRequest)`. It owns 402
challenge handling, exact-byte replay, signing, and a spending cap. Read-only
operations use a separate credential-free transport. Without a payment
authority, `invoke` refuses before sending a paid request. `probe` inspects
the unsigned challenge without paying.

Save a unique idempotency key before purchase. On `UncertainException`, retry
only with the same input and key; a new key starts a new purchase. `commit`
stores immutable input bytes, `access` mints bodyless download access, and
`invocation` reads state without payment. The [agent contract](https://ausca.com/SKILL.md)
explains the offer-specific lifecycle and limits.
