<?php
declare(strict_types=1);

namespace Ausca;

use InvalidArgumentException;
use RuntimeException;
use Throwable;

/** Catalog-bound buyer client; all payment behavior lives in Transport. */
final class Client
{
    public const ORIGIN = 'https://ausca.com';
    public const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
    private ?string $catalogJson = null;
    private Transport $read;
    private string $origin;

    public function __construct(private readonly ?Transport $payment = null, string $origin = self::ORIGIN, ?Transport $read = null)
    {
        $this->origin = rtrim($origin, '/');
        $this->read = $read ?? new HttpTransport();
    }

    /** @return list<array<string,mixed>> */
    public function catalog(bool $refresh = false): array
    {
        if ($this->catalogJson === null || $refresh) {
            $response = $this->request($this->read, 'GET', '/catalog.json');
            if ($response->status !== 200) {
                throw new RuntimeException("Catalog answered {$response->status}");
            }
            $document = $this->json($response->body);
            if (!is_array($document) || !isset($document['offers']) || !is_array($document['offers'])) {
                throw new RuntimeException('Catalog has no offers');
            }
            foreach ($document['offers'] as $offer) {
                $this->validateOffer($offer);
            }
            $this->catalogJson = $response->body;
        }
        return $this->json($this->catalogJson)['offers'];
    }

    /** @return array<string,mixed> */
    public function offer(string $offerId): array
    {
        foreach ($this->catalog() as $offer) {
            if ($offer['offer_id'] === $offerId) {
                return $offer;
            }
        }
        throw new InvalidArgumentException("Offer {$offerId} is not active in the catalog");
    }

    /** @return array<string,mixed> */
    public function price(string $offerId): array
    {
        return $this->offer($offerId)['price'];
    }

    /** @param array<string,mixed> $offer
     *  @param ?array{source:string,campaign?:string} $attribution
     *  @return array<string,mixed>
     */
    public function envelope(array $offer, mixed $input, ?string $idempotencyKey = null, ?array $attribution = null): array
    {
        $this->validateOffer($offer);
        $key = $idempotencyKey ?? $this->newKey('ausca-');
        $this->validateKey($key);
        if ($attribution !== null) {
            if (array_diff(array_keys($attribution), ['source', 'campaign']) ||
                !$this->validLabel($attribution['source'] ?? null, 64) ||
                (isset($attribution['campaign']) && !$this->validLabel($attribution['campaign'], 128))) {
                throw new InvalidArgumentException('Attribution source and campaign must be bounded lowercase labels');
            }
        }
        $body = [
            'offer_id' => $offer['offer_id'],
            'offer_revision' => $offer['revision'],
            'offer_revision_digest' => $offer['revision_digest'],
            'input_schema_digest' => $offer['input_schema']['digest'],
            'output_schema_digest' => $offer['output_schema']['digest'],
            'input' => $input,
            'idempotency_key' => $key,
        ];
        if ($attribution !== null) {
            $body['attribution'] = $attribution;
        }
        return $body;
    }

    /** @return array{response:Response,identity:array{offer_id:string,idempotency_key:string}} */
    public function probe(string $offerId, mixed $input, ?string $idempotencyKey = null): array
    {
        $offer = $this->offer($offerId);
        $body = $this->envelope($offer, $input, $idempotencyKey);
        $response = $this->request($this->read, 'POST', $offer['route']['path'], $this->encode($body));
        return ['response' => $response, 'identity' => $this->identity($body)];
    }

    /** @param ?callable(array{offer_id:string,idempotency_key:string}):void $beforePayment
     *  @return array{status:int,body:mixed,identity:array{offer_id:string,idempotency_key:string}}
     */
    public function invoke(string $offerId, mixed $input, ?string $idempotencyKey = null, ?array $attribution = null, ?callable $beforePayment = null): array
    {
        if ($this->payment === null) {
            throw new RuntimeException('Payment authority is required for invoke');
        }
        $offer = $this->offer($offerId);
        $body = $this->envelope($offer, $input, $idempotencyKey, $attribution);
        $identity = $this->identity($body);
        $serialized = $this->encode($body);
        if ($beforePayment !== null) {
            $beforePayment($identity);
        }
        try {
            $response = $this->request($this->payment, 'POST', $offer['route']['path'], $serialized);
        } catch (Throwable $error) {
            throw new UncertainException($identity, $error);
        }
        try {
            $decoded = $this->json($response->body);
        } catch (Throwable $error) {
            throw new UncertainException($identity, $error);
        }
        if ($response->status >= 400) {
            throw new RefusalException($response->status, $decoded, $identity);
        }
        return ['status' => $response->status, 'body' => $decoded, 'identity' => $identity];
    }

    public function invocation(string $invocationId): mixed
    {
        if ($invocationId === '') {
            throw new InvalidArgumentException('Invocation ID is required');
        }
        $response = $this->request($this->read, 'GET', '/v1/invocations/' . rawurlencode($invocationId));
        if ($response->status !== 200) {
            throw new RuntimeException("Invocation read answered {$response->status}");
        }
        return $this->json($response->body);
    }

    /** @return array{artifact_ref:string,content_digest:string,media_type:string} */
    public function commit(string $bytes, string $mediaType, ?string $idempotencyKey = null): array
    {
        if (strlen($bytes) < 1 || strlen($bytes) > self::MAX_ARTIFACT_BYTES) {
            throw new InvalidArgumentException('Artifact size exceeds the platform ingress limit');
        }
        if ($mediaType === '' || strlen($mediaType) > 200 || trim($mediaType) !== $mediaType) {
            throw new InvalidArgumentException('Invalid artifact media type');
        }
        $key = $idempotencyKey ?? $this->newKey('ausca-artifact-');
        $this->validateKey($key);
        $digest = 'sha256:' . hash('sha256', $bytes);
        $body = $this->encode([
            'data_base64' => base64_encode($bytes), 'content_digest' => $digest,
            'media_type' => $mediaType, 'idempotency_key' => $key,
        ]);
        try {
            $response = $this->request($this->read, 'POST', '/v1/artifacts', $body);
        } catch (Throwable $error) {
            throw new RuntimeException("Artifact commit uncertain; reuse key {$key}", 0, $error);
        }
        if ($response->status !== 200) {
            throw new RuntimeException("Artifact ingress answered {$response->status}; reuse key {$key}");
        }
        try {
            $result = $this->json($response->body);
        } catch (Throwable $error) {
            throw new RuntimeException("Artifact commit uncertain; reuse key {$key}", 0, $error);
        }
        $artifact = $result['artifact'] ?? null;
        if (($result['status'] ?? null) !== 'stored' || !is_array($artifact) ||
            !is_string($artifact['artifact_ref'] ?? null) || strlen($artifact['artifact_ref']) < 1 || strlen($artifact['artifact_ref']) > 512 ||
            ($artifact['content_digest'] ?? null) !== $digest || ($artifact['media_type'] ?? null) !== $mediaType ||
            ($artifact['size_bytes'] ?? null) !== strlen($bytes) || !is_string($artifact['created_at'] ?? null)) {
            throw new RuntimeException("Artifact ingress returned mismatched evidence; reuse key {$key}");
        }
        return ['artifact_ref' => $artifact['artifact_ref'], 'content_digest' => $digest, 'media_type' => $mediaType];
    }

    /** @return array<string,mixed> */
    public function access(string $artifactRef, ?string $idempotencyKey = null): array
    {
        if ($artifactRef === '' || strlen($artifactRef) > 512) {
            throw new InvalidArgumentException('Invalid artifact reference');
        }
        $key = $idempotencyKey ?? $this->newKey('ausca-');
        $this->validateKey($key);
        $response = $this->request($this->read, 'POST', '/v1/artifacts/' . rawurlencode($artifactRef) . '/access', null, ['Idempotency-Key' => $key]);
        if ($response->status !== 200) {
            throw new RuntimeException("Artifact access answered {$response->status}");
        }
        $result = $this->json($response->body);
        $artifact = $result['artifact'] ?? null;
        if (($result['status'] ?? null) !== 'ready' || !is_array($artifact) ||
            ($artifact['artifact_ref'] ?? null) !== $artifactRef || !is_string($artifact['content_digest'] ?? null) ||
            !is_string($artifact['download_url'] ?? null) || !is_string($artifact['expires_at'] ?? null)) {
            throw new RuntimeException('Artifact access returned invalid evidence');
        }
        return $artifact;
    }

    private function request(Transport $transport, string $method, string $path, ?string $body = null, array $headers = []): Response
    {
        if (!str_starts_with($path, '/') || str_starts_with($path, '//')) {
            throw new InvalidArgumentException('Invalid resource path');
        }
        if ($body !== null) {
            $headers['Content-Type'] = 'application/json';
        }
        return $transport->send(new Request($method, $this->origin . $path, $body, $headers));
    }

    private function json(string $body): mixed
    {
        return json_decode($body, true, 512, JSON_THROW_ON_ERROR);
    }

    private function encode(mixed $body): string
    {
        return json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    }

    /** @param array<string,mixed> $body
     *  @return array{offer_id:string,idempotency_key:string}
     */
    private function identity(array $body): array
    {
        return ['offer_id' => $body['offer_id'], 'idempotency_key' => $body['idempotency_key']];
    }

    private function validateOffer(mixed $offer): void
    {
        if (!is_array($offer) || !is_string($offer['offer_id'] ?? null) || $offer['offer_id'] === '' ||
            !is_string($offer['revision'] ?? null) || $offer['revision'] === '' ||
            !is_string($offer['revision_digest'] ?? null) || $offer['revision_digest'] === '' ||
            !is_string($offer['input_schema']['digest'] ?? null) || $offer['input_schema']['digest'] === '' ||
            !is_string($offer['output_schema']['digest'] ?? null) || $offer['output_schema']['digest'] === '' ||
            ($offer['route']['method'] ?? null) !== 'POST' || !is_string($offer['route']['path'] ?? null) ||
            !str_starts_with($offer['route']['path'], '/v1/') || str_contains($offer['route']['path'], '..') ||
            strpbrk($offer['route']['path'], '?#') !== false) {
            throw new RuntimeException('Invalid catalog offer binding');
        }
    }

    private function validateKey(string $key): void
    {
        if (strlen($key) < 16 || strlen($key) > 128 || trim($key) !== $key ||
            preg_match('//u', $key) !== 1 || preg_match('/[\x00-\x1f\x7f]/', $key)) {
            throw new InvalidArgumentException('Idempotency key must be 16 to 128 clean UTF-8 bytes');
        }
    }

    private function validLabel(mixed $value, int $max): bool
    {
        return is_string($value) && strlen($value) <= $max && preg_match('/^[a-z0-9][a-z0-9._-]*$/D', $value) === 1;
    }

    private function newKey(string $prefix): string
    {
        return $prefix . bin2hex(random_bytes(16));
    }
}
