<?php

declare(strict_types=1);

/** Resolve the installed Screen version without attaching or modifying a display. */
function borkLayoutScreenCapabilities(): array
{
    return ['supported' => false, 'version' => execute(['screen', '--version']),
        'missing' => ['a documented remote display identity and complete region-geometry snapshot'],
        'reason' => 'Screen layout mutation is blocked until attached-display identity, region sizes, window assignments and focus can be verified. Screen 4.09 remote queries omit these; layout dump omits sizes and assignments. Separate sessions are not substituted.'];
}
