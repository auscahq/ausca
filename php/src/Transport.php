<?php
declare(strict_types=1);

namespace Ausca;

/** Payment implementations own signing, 402 retry, and spend limits. */
interface Transport
{
    public function send(Request $request): Response;
}
