package com.ausca;

import java.io.IOException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

/** Credential-free default transport for catalog, probe and state reads. */
public final class HttpTransport implements Transport {
    private static final HttpClient SHARED = HttpClient.newHttpClient();
    private final HttpClient client;

    public HttpTransport() { this(SHARED); }
    public HttpTransport(HttpClient client) { this.client = client; }

    @Override public WireResponse send(WireRequest request) throws IOException, InterruptedException {
        var body = request.body();
        var builder = HttpRequest.newBuilder(request.uri()).method(request.method(),
                body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));
        request.headers().forEach(builder::header);
        var response = client.send(builder.build(), HttpResponse.BodyHandlers.ofByteArray());
        return new WireResponse(response.statusCode(), response.body());
    }
}
