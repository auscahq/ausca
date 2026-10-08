<?php
declare(strict_types=1);

namespace Ausca;

use RuntimeException;
use Throwable;

final class UncertainException extends RuntimeException
{
    /** @param array{offer_id:string,idempotency_key:string} $identity */
    public function __construct(public readonly array $identity, ?Throwable $cause = null)
    {
        parent::__construct("Ausca outcome uncertain; recover {$identity['offer_id']} with the same input and key {$identity['idempotency_key']}", 0, $cause);
    }
}
