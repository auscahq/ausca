<?php
declare(strict_types=1);

namespace Ausca;

/** Complete, replayable request bytes handed to a payment authority. */
final readonly class Request
{
    /** @param array<string,string> $headers */
    public function __construct(
        public string $method,
        public string $url,
        public ?string $body = null,
        public array $headers = [],
    ) {}
}
