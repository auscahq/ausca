import 'dart:convert';

import 'package:http/http.dart' as http;

/// Immutable wire request. A payment authority must replay these exact bytes.
final class WireRequest {
  WireRequest(this.method, this.uri, List<int> body,
      [Map<String, String>? headers])
      : body = List.unmodifiable(body),
        headers = Map.unmodifiable(headers ?? const {});

  final String method;
  final Uri uri;
  final List<int> body;
  final Map<String, String> headers;
}

final class WireResponse {
  WireResponse(this.status, List<int> body) : body = List.unmodifiable(body);

  final int status;
  final List<int> body;

  String get text => utf8.decode(body);
}

/// The payment boundary. Implementations own signing, spend caps and 402 retry.
abstract interface class Transport {
  Future<WireResponse> send(WireRequest request);
}

/// Keyless HTTP transport used only for catalog, probe and state reads.
final class HttpTransport implements Transport {
  HttpTransport([http.Client? client]) : _client = client ?? http.Client();

  final http.Client _client;

  @override
  Future<WireResponse> send(WireRequest request) async {
    final outgoing = http.Request(request.method, request.uri);
    outgoing.headers.addAll(request.headers);
    outgoing.bodyBytes = request.body;
    final response =
        await http.Response.fromStream(await _client.send(outgoing));
    return WireResponse(response.statusCode, response.bodyBytes);
  }

  void close() => _client.close();
}
