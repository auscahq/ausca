import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';

import 'transport.dart';

const auscaOrigin = 'https://ausca.com';
const maxArtifactBytes = 25 * 1024 * 1024;

final class PurchaseIdentity {
  const PurchaseIdentity(this.offerId, this.idempotencyKey);

  final String offerId;
  final String idempotencyKey;
}

final class InvocationResult {
  const InvocationResult(this.status, this.body, this.identity);

  final int status;
  final Map<String, dynamic> body;
  final PurchaseIdentity identity;
}

final class ProbeResult {
  const ProbeResult(this.response, this.identity);

  final WireResponse response;
  final PurchaseIdentity identity;
}

final class RefusalException implements Exception {
  const RefusalException(this.status, this.body, this.identity);

  final int status;
  final Map<String, dynamic> body;
  final PurchaseIdentity identity;

  @override
  String toString() => 'Ausca refused purchase with HTTP $status';
}

final class UncertainException implements Exception {
  const UncertainException(this.identity, this.cause);

  final PurchaseIdentity identity;
  final Object cause;

  @override
  String toString() =>
      'Ausca outcome uncertain; recover with the same input and ${identity.idempotencyKey}';
}

/// Resolves current offer bindings; only [payment] may authorize a purchase.
final class AuscaClient {
  AuscaClient(
      {Transport? payment, Transport? read, String origin = auscaOrigin})
      : _payment = payment,
        _read = read ?? HttpTransport(),
        _origin = Uri.parse(origin);

  final Transport? _payment;
  final Transport _read;
  final Uri _origin;
  String? _catalogSource;

  Future<List<Map<String, dynamic>>> catalog({bool refresh = false}) async {
    if (_catalogSource == null || refresh) {
      final response = await _request(_read, 'GET', '/catalog.json');
      if (response.status != 200) {
        throw StateError('Catalog answered ${response.status}');
      }
      final source = response.text;
      final offers = _parseCatalog(source);
      _catalogSource = source;
      return offers;
    }
    return _parseCatalog(_catalogSource!);
  }

  List<Map<String, dynamic>> _parseCatalog(String source) {
    final document = jsonDecode(source);
    if (document is! Map<String, dynamic>) {
      throw const FormatException('Invalid catalog document');
    }
    final raw = document['offers'];
    if (raw is! List) throw const FormatException('Catalog has no offers');
    final offers = raw.map((item) {
      if (item is! Map<String, dynamic>)
        throw const FormatException('Invalid catalog offer');
      _validateOffer(item);
      return item;
    }).toList(growable: false);
    return offers;
  }

  Future<Map<String, dynamic>> offer(String offerId) async {
    for (final item in await catalog()) {
      if (item['offer_id'] == offerId) return item;
    }
    throw ArgumentError.value(offerId, 'offerId', 'Not active in catalog');
  }

  Future<Map<String, dynamic>> price(String offerId) async =>
      (await offer(offerId))['price'] as Map<String, dynamic>;

  Map<String, dynamic> envelope(
    Map<String, dynamic> binding,
    Object? input, {
    String? idempotencyKey,
    Map<String, String>? attribution,
  }) {
    _validateOffer(binding);
    final key = idempotencyKey ?? _newKey('ausca-');
    _validateKey(key);
    if (attribution != null) _validateAttribution(attribution);
    return {
      'offer_id': binding['offer_id'],
      'offer_revision': binding['revision'],
      'offer_revision_digest': binding['revision_digest'],
      'input_schema_digest': (binding['input_schema'] as Map)['digest'],
      'output_schema_digest': (binding['output_schema'] as Map)['digest'],
      'input': input,
      'idempotency_key': key,
      if (attribution != null) 'attribution': attribution,
    };
  }

  Future<ProbeResult> probe(String offerId, Object? input,
      {String? idempotencyKey}) async {
    final binding = await offer(offerId);
    final body = envelope(binding, input, idempotencyKey: idempotencyKey);
    final identity =
        PurchaseIdentity(offerId, body['idempotency_key'] as String);
    final response = await _request(
        _read, 'POST', (binding['route'] as Map)['path'] as String,
        body: utf8.encode(jsonEncode(body)));
    return ProbeResult(response, identity);
  }

  Future<InvocationResult> invoke(
    String offerId,
    Object? input, {
    String? idempotencyKey,
    Map<String, String>? attribution,
    Future<void> Function(PurchaseIdentity)? beforePayment,
  }) async {
    final payment = _payment;
    if (payment == null)
      throw StateError('Payment authority is required for invoke');
    final binding = await offer(offerId);
    final body = envelope(binding, input,
        idempotencyKey: idempotencyKey, attribution: attribution);
    final identity =
        PurchaseIdentity(offerId, body['idempotency_key'] as String);
    final bytes = utf8.encode(jsonEncode(body));
    if (beforePayment != null) await beforePayment(identity);
    late final WireResponse response;
    try {
      response = await _request(
          payment, 'POST', (binding['route'] as Map)['path'] as String,
          body: bytes);
    } catch (error) {
      throw UncertainException(identity, error);
    }
    late final Map<String, dynamic> decoded;
    try {
      decoded = _json(response);
    } catch (error) {
      throw UncertainException(identity, error);
    }
    if (response.status >= 400)
      throw RefusalException(response.status, decoded, identity);
    return InvocationResult(response.status, decoded, identity);
  }

  Future<Map<String, dynamic>> invocation(String invocationId) async {
    if (invocationId.isEmpty)
      throw ArgumentError.value(invocationId, 'invocationId');
    final response = await _request(
        _read, 'GET', '/v1/invocations/${Uri.encodeComponent(invocationId)}');
    if (response.status != 200)
      throw StateError('Invocation answered ${response.status}');
    return _json(response);
  }

  Future<Map<String, String>> commit(List<int> bytes, String mediaType,
      {String? idempotencyKey}) async {
    if (bytes.isEmpty || bytes.length > maxArtifactBytes) {
      throw ArgumentError.value(
          bytes.length, 'bytes', 'Outside artifact ingress limit');
    }
    if (mediaType.isEmpty ||
        mediaType.length > 200 ||
        mediaType.trim() != mediaType) {
      throw ArgumentError.value(mediaType, 'mediaType');
    }
    final key = idempotencyKey ?? _newKey('ausca-artifact-');
    _validateKey(key);
    final digest = 'sha256:${sha256.convert(bytes)}';
    final body = utf8.encode(jsonEncode({
      'data_base64': base64Encode(bytes),
      'content_digest': digest,
      'media_type': mediaType,
      'idempotency_key': key,
    }));
    late final WireResponse response;
    try {
      response = await _request(_read, 'POST', '/v1/artifacts', body: body);
    } catch (error) {
      throw StateError('Artifact commit uncertain; reuse key $key: $error');
    }
    if (response.status != 200)
      throw StateError(
          'Artifact ingress answered ${response.status}; reuse key $key');
    late final Map<String, dynamic> result;
    try {
      result = _json(response);
    } catch (error) {
      throw StateError('Artifact commit uncertain; reuse key $key: $error');
    }
    final artifact = result['artifact'];
    if (result['status'] != 'stored' ||
        artifact is! Map ||
        artifact['artifact_ref'] is! String ||
        (artifact['artifact_ref'] as String).isEmpty ||
        artifact['content_digest'] != digest ||
        artifact['media_type'] != mediaType ||
        artifact['size_bytes'] != bytes.length ||
        artifact['created_at'] is! String) {
      throw StateError(
          'Artifact ingress returned mismatched evidence; reuse key $key');
    }
    return {
      'artifact_ref': artifact['artifact_ref'] as String,
      'content_digest': digest,
      'media_type': mediaType,
    };
  }

  Future<Map<String, dynamic>> access(String artifactRef,
      {String? idempotencyKey}) async {
    if (artifactRef.isEmpty || artifactRef.length > 512) {
      throw ArgumentError.value(artifactRef, 'artifactRef');
    }
    final key = idempotencyKey ?? _newKey('ausca-');
    _validateKey(key);
    final response = await _request(_read, 'POST',
        '/v1/artifacts/${Uri.encodeComponent(artifactRef)}/access',
        headers: {'Idempotency-Key': key});
    if (response.status != 200)
      throw StateError('Artifact access answered ${response.status}');
    final result = _json(response);
    final artifact = result['artifact'];
    if (result['status'] != 'ready' ||
        artifact is! Map<String, dynamic> ||
        artifact['artifact_ref'] != artifactRef ||
        artifact['content_digest'] is! String ||
        artifact['download_url'] is! String ||
        artifact['expires_at'] is! String) {
      throw const FormatException('Artifact access returned invalid evidence');
    }
    return artifact;
  }

  Future<WireResponse> _request(Transport transport, String method, String path,
      {List<int>? body, Map<String, String>? headers}) {
    if (!path.startsWith('/') ||
        path.startsWith('//') ||
        path.contains('..') ||
        path.contains('?') ||
        path.contains('#')) {
      throw ArgumentError.value(path, 'path', 'Invalid resource path');
    }
    return transport
        .send(WireRequest(method, _origin.resolve(path), body ?? const [], {
      ...?headers,
      if (body != null) 'Content-Type': 'application/json',
    }));
  }
}

Map<String, dynamic> _json(WireResponse response) {
  final value = jsonDecode(response.text);
  if (value is! Map<String, dynamic>)
    throw const FormatException('Expected JSON object');
  return value;
}

void _validateOffer(Map<String, dynamic> offer) {
  final input = offer['input_schema'];
  final output = offer['output_schema'];
  final route = offer['route'];
  if (offer['offer_id'] is! String ||
      (offer['offer_id'] as String).isEmpty ||
      offer['revision'] is! String ||
      (offer['revision'] as String).isEmpty ||
      offer['revision_digest'] is! String ||
      (offer['revision_digest'] as String).isEmpty ||
      input is! Map ||
      input['digest'] is! String ||
      (input['digest'] as String).isEmpty ||
      output is! Map ||
      output['digest'] is! String ||
      (output['digest'] as String).isEmpty ||
      route is! Map ||
      route['method'] != 'POST' ||
      route['path'] is! String ||
      !(route['path'] as String).startsWith('/v1/') ||
      (route['path'] as String).contains('..') ||
      (route['path'] as String).contains(RegExp(r'[?#]'))) {
    throw const FormatException('Invalid catalog offer binding');
  }
}

void _validateKey(String key) {
  final bytes = utf8.encode(key);
  if (bytes.length < 16 ||
      bytes.length > 128 ||
      key.trim() != key ||
      key.runes.any((value) => value < 32 || value == 127)) {
    throw ArgumentError.value(
        key, 'idempotencyKey', 'Must be 16 to 128 clean UTF-8 bytes');
  }
}

void _validateAttribution(Map<String, String> attribution) {
  final pattern = RegExp(r'^[a-z0-9][a-z0-9._-]*$');
  if (attribution.keys.any((key) => key != 'source' && key != 'campaign') ||
      !pattern.hasMatch(attribution['source'] ?? '') ||
      (attribution['source']?.length ?? 0) > 64 ||
      (attribution.containsKey('campaign') &&
          (!pattern.hasMatch(attribution['campaign']!) ||
              attribution['campaign']!.length > 128))) {
    throw ArgumentError.value(
        attribution, 'attribution', 'Invalid source or campaign');
  }
}

String _newKey(String prefix) {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  return '$prefix${bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join()}';
}
