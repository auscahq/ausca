<?php
declare(strict_types=1);

namespace Ausca;

use RuntimeException;

final class RefusalException extends RuntimeException
{
    /** @param array{offer_id:string,idempotency_key:string} $identity */
    public function __construct(public readonly int $status, public readonly mixed $body, public readonly array $identity)
    {
        parent::__construct("Ausca answered {$status}; inspect the body and retain purchase key {$identity['idempotency_key']}");
    }
}
