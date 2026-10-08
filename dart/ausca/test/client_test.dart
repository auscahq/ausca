import 'dart:convert';
import 'dart:io';

import 'package:ausca/ausca.dart';
import 'package:test/test.dart';

final class RecordingTransport implements Transport {
  RecordingTransport(this.reply);

  final Future<WireResponse> Function(WireRequest) reply;
  final requests = <WireRequest>[];

  @override
  Future<WireResponse> send(WireRequest request) async {
    requests.add(request);
    return reply(request);
  }
}

WireResponse jsonResponse(int status, Object value) =>
    WireResponse(status, utf8.encode(jsonEncode(value)));

final offerBinding = {
  'offer_id': 'browser.session',
  'revision': '1',
  'revision_digest': 'revision-digest',
  'input_schema': {'digest': 'input-digest'},
  'output_schema': {'digest': 'output-digest'},
  'route': {'method': 'POST', 'path': '/v1/offers/browser.session/invoke'},
  'price': {'currency': 'USD', 'minimum_minor': 5},
};

void main() {
  test('catalog, price and challenge inspection never call payment authority',
      () async {
    final read = RecordingTransport((request) async {
      if (request.uri.path == '/catalog.json') {
        return jsonResponse(200, {
          'offers': [offerBinding]
        });
      }
      return jsonResponse(402, {'error': 'payment_required'});
    });
    final payment = RecordingTransport(
        (_) async => throw StateError('payment should not be called'));
    final client = AuscaClient(read: read, payment: payment);
    expect((await client.price('browser.session'))['currency'], 'USD');
    final exposed = await client.catalog();
    exposed.single['revision_digest'] = 'caller-mutated';
    final probe = await client.probe(
        'browser.session', {'duration_seconds': 600},
        idempotencyKey: 'fixed-purchase-key-0001');
    expect(probe.response.status, 402);
    expect(probe.identity.idempotencyKey, 'fixed-purchase-key-0001');
    expect(
        jsonDecode(utf8.decode(read.requests.last.body))['input_schema_digest'],
        'input-digest');
    expect(
        jsonDecode(
            utf8.decode(read.requests.last.body))['offer_revision_digest'],
        'revision-digest');
    expect(payment.requests, isEmpty);
  });

  test('paid invocation retains identity before contacting the payment port',
      () async {
    final read = RecordingTransport((_) async => jsonResponse(200, {
          'offers': [offerBinding]
        }));
    final events = <String>[];
    final payment = RecordingTransport((request) async {
      events.add('payment');
      return jsonResponse(200, {'status': 'succeeded'});
    });
    final client = AuscaClient(read: read, payment: payment);
    final result = await client.invoke(
        'browser.session', {'duration_seconds': 600},
        idempotencyKey: 'fixed-purchase-key-0001',
        attribution: {'source': 'dart-test'}, beforePayment: (identity) async {
      expect(identity.offerId, 'browser.session');
      events.add('persist');
    });
    expect(events, ['persist', 'payment']);
    expect(result.body['status'], 'succeeded');
    final sent = payment.requests.single;
    expect(sent.uri.toString(),
        'https://ausca.com/v1/offers/browser.session/invoke');
    expect(sent.headers['Content-Type'], 'application/json');
    final envelope = jsonDecode(utf8.decode(sent.body)) as Map<String, dynamic>;
    expect(envelope['offer_revision_digest'], 'revision-digest');
    expect(envelope['output_schema_digest'], 'output-digest');
    expect(envelope['idempotency_key'], 'fixed-purchase-key-0001');
    expect(envelope['attribution'], {'source': 'dart-test'});
  });

  test('missing authority and failed persistence cannot start payment',
      () async {
    final read = RecordingTransport((_) async => jsonResponse(200, {
          'offers': [offerBinding]
        }));
    final bare = AuscaClient(read: read);
    await expectLater(
        bare.invoke('browser.session', {}), throwsA(isA<StateError>()));
    expect(read.requests, isEmpty);

    final payment = RecordingTransport((_) async => jsonResponse(200, {}));
    final client = AuscaClient(read: read, payment: payment);
    await expectLater(
        client.invoke('browser.session', {},
            idempotencyKey: 'fixed-purchase-key-0001',
            beforePayment: (_) async => throw StateError('not saved')),
        throwsA(isA<StateError>()));
    expect(payment.requests, isEmpty);
  });

  test('uncertain transport and typed refusal preserve purchase identity',
      () async {
    final read = RecordingTransport((_) async => jsonResponse(200, {
          'offers': [offerBinding]
        }));
    final uncertain = AuscaClient(
        read: read,
        payment: RecordingTransport(
            (_) async => throw const SocketException('reset')));
    try {
      await uncertain.invoke('browser.session', {},
          idempotencyKey: 'fixed-purchase-key-0001');
      fail('expected uncertainty');
    } on UncertainException catch (error) {
      expect(error.identity.idempotencyKey, 'fixed-purchase-key-0001');
    }

    final refused = AuscaClient(
        read: read,
        payment: RecordingTransport(
            (_) async => jsonResponse(409, {'error': 'conflict'})));
    try {
      await refused.invoke('browser.session', {},
          idempotencyKey: 'fixed-purchase-key-0001');
      fail('expected refusal');
    } on RefusalException catch (error) {
      expect(error.status, 409);
      expect(error.body['error'], 'conflict');
      expect(error.identity.idempotencyKey, 'fixed-purchase-key-0001');
    }
  });

  test('artifact commit checks evidence and access is bodyless', () async {
    final bytes = utf8.encode('hello');
    final read = RecordingTransport((request) async {
      if (request.uri.path == '/v1/artifacts') {
        return jsonResponse(200, {
          'status': 'stored',
          'artifact': {
            'artifact_ref': 'artifact-1',
            'content_digest':
                'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
            'media_type': 'text/plain',
            'size_bytes': 5,
            'created_at': '2026-10-08T00:00:00Z'
          }
        });
      }
      return jsonResponse(200, {
        'status': 'ready',
        'artifact': {
          'artifact_ref': 'artifact-1',
          'content_digest':
              'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
          'download_url': 'https://example.com/download',
          'expires_at': '2026-10-08T01:00:00Z'
        }
      });
    });
    final client = AuscaClient(read: read);
    final artifact = await client.commit(bytes, 'text/plain',
        idempotencyKey: 'artifact-purchase-key-0001');
    expect(artifact['artifact_ref'], 'artifact-1');
    final access = await client.access('artifact-1',
        idempotencyKey: 'access-purchase-key-0001');
    expect(access['download_url'], 'https://example.com/download');
    expect(read.requests.last.body, isEmpty);
    expect(read.requests.last.headers['Idempotency-Key'],
        'access-purchase-key-0001');
  });

  test('live catalog remains compatible', () async {
    if (Platform.environment['AUSCA_LIVE_TEST'] != '1') return;
    final client = AuscaClient();
    final offers = await client.catalog();
    expect(offers, isNotEmpty);
    expect(await client.offer('browser.session'), isNotEmpty);
  });
}
