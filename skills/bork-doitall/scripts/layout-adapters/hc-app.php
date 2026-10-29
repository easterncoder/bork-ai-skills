<?php

declare(strict_types=1);

/** Discover app visual capabilities without opening or raising the app. */
function borkLayoutAppCapabilities(): array
{
    $commands = json_decode(execute(['herdr-app', 'commands']), true, 512, JSON_THROW_ON_ERROR);
    $byName = [];
    foreach ($commands as $command) {
        $byName[$command['name']] = array_column($command['args'], 'name');
    }
    $missing = [];
    if (!isset($byName['pane.layout'])) {
        $missing[] = 'a documented per-pane geometry and split-tree snapshot';
    }
    if (!in_array('no_focus', $byName['pane.split'] ?? [], true)) {
        $missing[] = 'a documented background split that preserves focus';
    }
    return ['supported' => false, 'commands_sha256' => hash('sha256', json_encode($commands, JSON_THROW_ON_ERROR)),
        'missing' => $missing, 'reason' => 'Herdr App visual layout cannot be verified by the installed command interface. Headless hc remains available; no app is launched and no topology is substituted.'];
}
