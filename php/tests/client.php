<?php
declare(strict_types=1);

spl_autoload_register(function (string $name): void {
    if (str_starts_with($name, 'Ausca\\')) {
        require dirname(__DIR__) . '/src/' . substr($name, strlen('Ausca\\')) . '.php';
    }
});

use Ausca\Client;
use Ausca\RefusalException;
use Ausca\Request;
use Ausca\Response;
use Ausca\Transport;
use Ausca\UncertainException;

const CATALOG = '{"offers":[{"offer_id":"browser.session","title":"Browser","description":"Session","revision":"r1","revision_digest":"sha256:revision","input_schema":{"digest":"sha256:input","public_path":"/input.json"},"output_schema":{"digest":"sha256:output","public_path":"/output.json"},"route":{"method":"POST","path":"/v1/lease-browser"},"price":{"currency":"USD","model":"input_choice","minimum_minor":5,"maximum_minor":20,"policy_digest":"sha256:price"}}]}';

final class FakeTransport implements Transport
{
    /** @var list<Request> */
    public array $requests = [];

    public function __construct(private readonly Closure $handler) {}

    public function send(Request $request): Response
    {
        $this->requests[] = $request;
        return ($this->handler)($request);
    }
}

function check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

$read = new FakeTransport(function (Request $request): Response {
    if (str_ends_with($request->url, '/catalog.json')) {
        return new Response(200, CATALOG);
    }
    if (str_ends_with($request->url, '/v1/lease-browser')) {
        return new Response(402, '{"accepts":[]}');
    }
    throw new RuntimeException('Unexpected read request');
});
$payment = new FakeTransport(fn (Request $request): Response => new Response(200, '{"status":"succeeded","receipt_ref":{"public_url":"https://runx.ai/r/test"}}'));
$client = new Client($payment, 'https://example.com', $read);
$key = 'browser-purchase-0001';
$identity = null;
$first = $client->invoke('browser.session', ['duration_seconds' => 600], $key, beforePayment: function (array $value) use (&$identity, $payment): void {
    check($payment->requests === [], 'Payment preceded identity persistence');
    $identity = $value;
});
$client->invoke('browser.session', ['duration_seconds' => 600], $key);
check($first['identity'] === $identity, 'Purchase identity changed');
check($payment->requests[0]->body === $payment->requests[1]->body, 'Retry changed envelope bytes');
check(json_decode($payment->requests[0]->body, true)['offer_revision_digest'] === 'sha256:revision', 'Binding digest missing');

$count = count($payment->requests);
$probe = $client->probe('browser.session', [], $key);
check($probe['response']->status === 402 && count($payment->requests) === $count, 'Probe paid');

$failed = new Client(new FakeTransport(fn (Request $request): Response => throw new RuntimeException('closed after send')), 'https://example.com', $read);
try {
    $failed->invoke('browser.session', [], $key);
    throw new RuntimeException('Expected uncertain outcome');
} catch (UncertainException $error) {
    check($error->identity['idempotency_key'] === $key, 'Uncertain result lost purchase identity');
}

$refused = new Client(new FakeTransport(fn (Request $request): Response => new Response(409, '{"code":"replay_conflict"}')), 'https://example.com', $read);
try {
    $refused->invoke('browser.session', [], $key);
    throw new RuntimeException('Expected typed refusal');
} catch (RefusalException $error) {
    check($error->status === 409 && $error->body['code'] === 'replay_conflict', 'Refusal lost body');
}

$uploads = new FakeTransport(function (Request $request): Response {
    if (str_ends_with($request->url, '/v1/artifacts')) {
        $body = json_decode($request->body, true);
        check($body['data_base64'] === 'dGVzdCBieXRlcw==', 'Wrong upload bytes');
        check($body['idempotency_key'] === 'artifact-upload-0001', 'Upload key changed');
        return new Response(200, json_encode(['status' => 'stored', 'artifact' => [
            'artifact_ref' => 'art_1', 'content_digest' => $body['content_digest'],
            'media_type' => 'text/plain', 'size_bytes' => 10, 'created_at' => 'now',
        ]]));
    }
    if (str_ends_with($request->url, '/v1/artifacts/art_1/access')) {
        check($request->body === null, 'Access carried a body');
        check($request->headers['Idempotency-Key'] === 'artifact-access-0001', 'Access key changed');
        return new Response(200, '{"status":"ready","artifact":{"artifact_ref":"art_1","content_digest":"sha256:test","media_type":"text/plain","size_bytes":10,"created_at":"now","download_url":"https://example.com/download","expires_at":"later"}}');
    }
    throw new RuntimeException('Unexpected artifact route');
});
$artifacts = new Client(null, 'https://example.com', $uploads);
$commitment = $artifacts->commit('test bytes', 'text/plain', 'artifact-upload-0001');
check($commitment['artifact_ref'] === 'art_1', 'Artifact commitment missing');
check($artifacts->access('art_1', 'artifact-access-0001')['download_url'] === 'https://example.com/download', 'Access missing');

if (getenv('AUSCA_LIVE_TEST') === '1') {
    $live = new Client();
    $offers = $live->catalog();
    check(count($offers) > 0, 'Live catalog empty');
    foreach ($offers as $offer) {
        $live->envelope($offer, []);
    }
    echo 'Validated ' . count($offers) . " live offers\n";
}
echo "PHP client tests passed\n";
