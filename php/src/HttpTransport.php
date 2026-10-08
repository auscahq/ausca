<?php
declare(strict_types=1);

namespace Ausca;

use RuntimeException;

/** Ordinary read/keyless transport; it never pays or holds wallet material. */
final class HttpTransport implements Transport
{
    private const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

    public function send(Request $request): Response
    {
        $headers = [];
        foreach ($request->headers as $name => $value) {
            $headers[] = $name . ': ' . $value;
        }
        $options = [
            'http' => [
                'method' => $request->method,
                'header' => implode("\r\n", $headers),
                'ignore_errors' => true,
                'follow_location' => 0,
                'timeout' => 60,
            ],
        ];
        if ($request->body !== null) {
            $options['http']['content'] = $request->body;
        }
        $stream = @fopen($request->url, 'rb', false, stream_context_create($options));
        if ($stream === false) {
            throw new RuntimeException('HTTP request failed');
        }
        try {
            $metadata = stream_get_meta_data($stream);
            $statusLine = $metadata['wrapper_data'][0] ?? '';
            if (!preg_match('/^HTTP\/\S+\s+(\d{3})\b/', $statusLine, $match)) {
                throw new RuntimeException('HTTP response has no status');
            }
            $body = stream_get_contents($stream, self::MAX_RESPONSE_BYTES + 1);
            if ($body === false || strlen($body) > self::MAX_RESPONSE_BYTES) {
                throw new RuntimeException('HTTP response exceeds client limit');
            }
            return new Response((int) $match[1], $body);
        } finally {
            fclose($stream);
        }
    }
}
