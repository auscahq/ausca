package com.ausca;

import java.io.IOException;
import java.net.URI;
import java.util.Map;

/** A payment implementation owns credentials, spend caps and exact-byte 402 replay. */
public interface Transport {
    WireResponse send(WireRequest request) throws IOException, InterruptedException;

    record WireRequest(String method, URI uri, byte[] body, Map<String, String> headers) {
        public WireRequest {
            body = body == null ? null : body.clone();
            headers = Map.copyOf(headers);
        }

        @Override public byte[] body() { return body == null ? null : body.clone(); }
    }

    record WireResponse(int status, byte[] body) {
        public WireResponse { body = body.clone(); }
        @Override public byte[] body() { return body.clone(); }
    }
}
