<?php
declare(strict_types=1);

namespace Ausca;

final readonly class Response
{
    public function __construct(public int $status, public string $body) {}
}
