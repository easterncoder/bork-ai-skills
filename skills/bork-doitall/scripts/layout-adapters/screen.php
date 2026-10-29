<?php

declare(strict_types=1);

/** Execute a Screen control through one verified attached display's exact tty. */
function borkLayoutScreen(array $context, array $args, bool $confirm = true): string
{
    $mutation = array_search('-X', $args, true);
    if ($confirm && $mutation !== false && ($args[$mutation + 1] ?? '') !== 'echo') {
        $prefix = array_slice($args, 0, $mutation);
        $command = array_slice($args, $mutation + 1);
        $nonce = 'BORKCONTROL' . bin2hex(random_bytes(10));
        if (($command[0] ?? '') === 'kill') {
            $target = $prefix[array_search('-p', $prefix, true) + 1] ?? null;
            if (!is_string($target) || !ctype_digit($target)) {
                throw new RuntimeException('Screen window removal requires an exact owned window.');
            }
            borkLayoutScreen($context, $args, false);
            $deadline = microtime(true) + 3;
            do {
                $windows = borkLayoutScreen($context, ['-Q', 'windows', '%n|%f;'], false);
                if (!preg_match('/(?:^|;)\s*' . preg_quote($target, '/') . '\|/', $windows)) {
                    return '';
                }
                usleep(10000);
            } while (microtime(true) < $deadline);
            throw new RuntimeException('Screen did not confirm owned window removal; retain pending intent.');
        }
        $query = ($command[0] ?? '') === 'layout' && in_array($command[1] ?? '', ['number', 'show'], true) && count($command) === 2;
        if ($query) {
            borkLayoutScreen($context, ['-X', 'echo', $nonce], false);
            borkLayoutScreenMessage($context, static fn (string $message): bool => $message === $nonce);
            borkLayoutScreen($context, $args, false);
            return borkLayoutScreenMessage($context, static fn (string $message): bool => $message !== $nonce);
        }
        $quoted = array_map(static function (string $arg): string {
            if (str_contains($arg, "\0")) {
                throw new RuntimeException('Screen control contains a null byte.');
            }
            return '"' . strtr($arg, ["\\" => "\\\\", '"' => '\\"', '$' => '\\$', '^' => '\\^', '#' => '\\#', "\n" => "\\n", "\r" => "\\r"]) . '"';
        }, $command);
        borkLayoutScreen($context, array_merge($prefix, ['-X', 'eval', implode(' ', $quoted), 'echo ' . $nonce]), false);
        try {
            borkLayoutScreenMessage($context, static fn (string $message): bool => $message === $nonce);
        } catch (Throwable $error) {
            throw new RuntimeException($error->getMessage() . ' Control: ' . implode(' ', array_slice($command, 0, 2)), 0, $error);
        }
        return '';
    }
    $session = field($context, 'session');
    if (!preg_match('/^([1-9][0-9]*)\.[a-zA-Z0-9_-]+$/D', $session, $match)) {
        throw new RuntimeException('Screen needs an exact local server PID.session identity.');
    }
    $tty = $context['display_tty'] ?? $context['window_tty'] ?? null;
    if (!is_string($tty) || !preg_match('#^/dev/(pts/[0-9]+|tty[a-zA-Z0-9]+)$#D', $tty) || !is_readable($tty)) {
        throw new RuntimeException('Screen requires a verified readable display or origin window tty.');
    }
    $environment = getenv();
    if (isset($context['socket_dir'])) {
        $environment['SCREENDIR'] = field($context, 'socket_dir');
    }
    $errors = fopen('php://temp', 'w+');
    $process = proc_open(array_merge(['screen', '-S', $session], $args), [0 => ['file', $tty, 'r'], 1 => ['pipe', 'w'], 2 => $errors], $pipes, null, $environment);
    if (!is_resource($process)) {
        throw new RuntimeException('Cannot address recorded Screen display.');
    }
    stream_set_blocking($pipes[1], false);
    $output = '';
    $deadline = microtime(true) + 5;
    while (!feof($pipes[1])) {
        $output .= stream_get_contents($pipes[1]);
        if (microtime(true) >= $deadline) {
            proc_terminate($process);
            fclose($pipes[1]);
            proc_close($process);
            fclose($errors);
            throw new RuntimeException('Screen control timed out; retain pending intent and reconcile without replay.');
        }
        usleep(10000);
    }
    fclose($pipes[1]);
    $code = proc_close($process);
    fclose($errors);
    if ($code !== 0) {
        throw new RuntimeException('Screen control failed; retain mutation intent before reconciliation.');
    }
    return trim($output);
}

/** Resolve exact display membership without attaching or changing focus. */
function borkLayoutScreenContext(array $context, string $coordinator): array
{
    if (!ctype_digit($coordinator)) {
        throw new RuntimeException('Screen coordinator must be a measured window number.');
    }
    $session = field($context, 'session');
    if (!preg_match('/^([1-9][0-9]*)\.[a-zA-Z0-9_-]+$/D', $session, $match)) {
        throw new RuntimeException('Screen session identity must include its local server PID.');
    }
    $pid = $match[1];
    $stat = @file_get_contents('/proc/' . $pid . '/stat');
    if ($stat === false) {
        throw new RuntimeException('Screen display discovery requires Linux procfs or a supported verified endpoint.');
    }
    $identity = explode(' ', substr($stat, strrpos($stat, ')') + 2))[19];
    if (isset($context['server_start']) && $context['server_start'] !== $identity) {
        throw new RuntimeException('Screen server PID was reused.');
    }
    $context['server_start'] = $identity;
    $candidates = [];
    foreach (glob('/proc/' . $pid . '/fd/*') ?: [] as $fd) {
        $target = @readlink($fd);
        if (is_string($target) && preg_match('#^/dev/pts/[0-9]+$#D', $target)) {
            $candidates[$target] = true;
        }
    }
    if (isset($context['display_tty'])) {
        if (!isset($candidates[$context['display_tty']])) {
            throw new RuntimeException('Recorded display tty is no longer owned by this Screen server.');
        }
        return $context;
    }
    $context['window_tty'] ??= getenv('TTY') ?: (function_exists('posix_ttyname') ? posix_ttyname(STDIN) : false);
    $flags = borkLayoutScreen($context, ['-Q', 'windows', '%n|%f;']);
    if (!preg_match('/(?:^|;)\s*' . preg_quote($coordinator, '/') . '\|([^;]*);/', $flags, $found) || str_contains($found[1], '&')) {
        throw new RuntimeException('Coordinator window is absent or displayed more than once; preserve all displays.');
    }
    $number = borkLayoutScreen($context, ['-Q', 'number']);
    if (!str_starts_with($number, $coordinator . ' ')) {
        throw new RuntimeException('Origin window tty does not identify the coordinator.');
    }
    $nonce = 'BORKDISPLAY' . bin2hex(random_bytes(12));
    borkLayoutScreen($context, ['-X', 'echo', $nonce]);
    $matches = [];
    foreach (array_keys($candidates) as $candidate) {
        $probe = array_replace($context, ['display_tty' => $candidate]);
        if (borkLayoutScreen($probe, ['-Q', 'lastmsg']) === $nonce) {
            $matches[] = $candidate;
        }
    }
    if (count($matches) !== 1) {
        throw new RuntimeException('Screen display nonce did not resolve exactly one attached display.');
    }
    $context['display_tty'] = $matches[0];
    return $context;
}

/** Verify the installed control surface before any region mutation. */
function borkLayoutScreenCapabilities(array $context = []): array
{
    return ['supported' => true, 'version' => execute(['screen', '--version']),
        'scope' => 'Attached local display, unique displayed windows, measured layout and exact tty routing.',
        'preflight_effect' => 'Automatic discovery updates only the owning display status message with a nonce.'];
}

/** Replay the documented layout dump into an ordered abstract split tree. */
function borkLayoutScreenTopology(string $dump): array
{
    $nodes = [0 => ['type' => 'leaf', 'parent' => null]];
    $leaves = [0];
    $focus = 0;
    foreach (preg_split('/\R/', trim($dump)) as $line) {
        if (trim($line) === 'focus') {
            $focus = ($focus + 1) % count($leaves);
            continue;
        }
        if (!in_array(trim($line), ['split', 'split -v'], true)) {
            throw new RuntimeException('Unrecognized Screen layout dump command: ' . json_encode($line));
        }
        $type = trim($line) === 'split -v' ? 'row' : 'column';
        $id = $leaves[$focus];
        $parent = $nodes[$id]['parent'];
        $new = count($nodes);
        $nodes[$new] = ['type' => 'leaf', 'parent' => $parent];
        if ($parent !== null && $nodes[$parent]['type'] === $type) {
            $offset = array_search($id, $nodes[$parent]['children'], true);
            array_splice($nodes[$parent]['children'], $offset + 1, 0, [$new]);
        } else {
            $container = count($nodes);
            $nodes[$container] = ['type' => $type, 'parent' => $parent, 'children' => [$id, $new]];
            if ($parent !== null) {
                $offset = array_search($id, $nodes[$parent]['children'], true);
                $nodes[$parent]['children'][$offset] = $container;
            }
            $nodes[$id]['parent'] = $container;
            $nodes[$new]['parent'] = $container;
        }
        array_splice($leaves, $focus + 1, 0, [$new]);
    }
    return ['nodes' => $nodes, 'leaves' => $leaves];
}

/** Compute region positions from topology and uniquely displayed PTY sizes. */
function borkLayoutScreenRect(array $nodes, int $id, array $measured, int $x, int $y, array &$panes): array
{
    $node = $nodes[$id];
    if ($node['type'] === 'leaf') {
        $pane = $measured[$id];
        $panes[$pane['id']] = $pane + ['x' => $x, 'y' => $y];
        return $pane;
    }
    $width = 0;
    $height = 0;
    foreach ($node['children'] as $index => $child) {
        $rect = borkLayoutScreenRect($nodes, $child, $measured, $x + ($node['type'] === 'row' ? $width : 0), $y + ($node['type'] === 'column' ? $height : 0), $panes);
        if ($node['type'] === 'row') {
            $width += $rect['width'] + 1;
            $height = max($height, $rect['height']);
        } else {
            $height += $rect['height'] + 1;
            $width = max($width, $rect['width']);
        }
    }
    return ['width' => $width - ($node['type'] === 'row' ? 1 : 0), 'height' => $height - ($node['type'] === 'column' ? 1 : 0)];
}

/** Traverse one exact display, restoring its original focus even when a gate fails. */
function borkLayoutScreenSnapshot(array $context, string $coordinator): array
{
    $context = borkLayoutScreenContext($context, $coordinator);
    $focus = explode(' ', borkLayoutScreen($context, ['-Q', 'number']), 2)[0];
    $dump = tempnam(sys_get_temp_dir(), 'bork-screen-dump-');
    try {
        borkLayoutScreen($context, ['-X', 'layout', 'dump', $dump]);
        $topology = borkLayoutScreenTopology(file_get_contents($dump));
        $flags = borkLayoutScreen($context, ['-Q', 'windows', '%n|%f;']);
        if (str_contains($flags, '&')) {
            throw new RuntimeException('Screen has multiply displayed windows; preserve their canvas geometry.');
        }
        $measured = [];
        borkLayoutScreen($context, ['-X', 'focus', 'top']);
        foreach ($topology['leaves'] as $leaf) {
            $id = explode(' ', borkLayoutScreen($context, ['-Q', 'number']), 2)[0];
            if (!ctype_digit($id) || isset($seen[$id])) {
                throw new RuntimeException('Blank or duplicate Screen regions cannot be measured safely.');
            }
            $seen[$id] = true;
            if (!preg_match('/(?:^|;)\s*' . preg_quote($id, '/') . '\|([^;]*);/', $flags, $found) || str_contains($found[1], '&')) {
                throw new RuntimeException('Displayed Screen window is shared; resizing would affect another canvas.');
            }
            if (!preg_match('#/\(([0-9]+),([0-9]+)\)#', borkLayoutScreen($context, ['-Q', 'info']), $size)) {
                throw new RuntimeException('Cannot measure Screen region terminal dimensions.');
            }
            $measured[$leaf] = ['id' => $id, 'width' => (int) $size[1], 'height' => (int) $size[2], 'window' => $context['session'], 'session' => $context['session']];
            borkLayoutScreen($context, ['-X', 'focus', 'next']);
        }
        $root = array_key_first(array_filter($topology['nodes'], static fn (array $node): bool => $node['parent'] === null));
        $panes = [];
        borkLayoutScreenRect($topology['nodes'], $root, $measured, 0, 0, $panes);
        return ['panes' => $panes, 'focus' => $focus, 'topology' => $topology, 'order' => array_column($measured, 'id')];
    } finally {
        @unlink($dump);
        borkLayoutScreenFocus($context, $focus, count($topology['leaves'] ?? []) + 1);
    }
}

/** Focus a unique displayed window without changing any window assignment. */
function borkLayoutScreenFocus(array $context, string $id, int $limit = 100): void
{
    borkLayoutScreen($context, ['-X', 'focus', 'top']);
    for ($index = 0; $index < $limit; $index++) {
        if (str_starts_with(borkLayoutScreen($context, ['-Q', 'number']), $id . ' ')) {
            return;
        }
        borkLayoutScreen($context, ['-X', 'focus', 'next']);
    }
    throw new RuntimeException('Recorded Screen region is no longer uniquely displayed.');
}

/** Save separate immutable backup and working layouts before changing regions. */
function borkLayoutScreenPrepare(array $record): array
{
    $context = $record['context'];
    $original = borkLayoutScreen($context, ['-X', 'layout', 'number']);
    $autosave = 'Original layout autosave is untouched.';
    $tag = 'bork' . bin2hex(random_bytes(8));
    $layouts = borkLayoutScreen($context, ['-X', 'layout', 'show']);
    if ($original === 'not on a layout' && !str_contains($layouts, 'No layouts defined')) {
        throw new RuntimeException('Screen has saved layouts but no active layout; preserve them until restoration can retain the active pointer.');
    }
    $record['screen'] = ['backup' => $tag . 'backup', 'working' => $tag . 'work', 'original_layout' => $original, 'original_autosave' => $autosave];
    $record['pending'] = ['prepare_layouts' => $record['screen']];
    borkLayoutWrite($record['record'], $record);
    borkLayoutScreen($context, ['-X', 'layout', 'save', $record['screen']['backup']]);
    borkLayoutScreen($context, ['-X', 'layout', 'autosave', 'off']);
    borkLayoutScreen($context, ['-X', 'layout', 'save', $record['screen']['working']]);
    borkLayoutScreen($context, ['-X', 'layout', 'autosave', 'off']);
    if (preg_match('/^This is layout ([0-9]+) \(/', $original, $match)) {
        borkLayoutScreen($context, ['-X', 'layout', 'select', $match[1]]);
        $saved = borkLayoutScreenSnapshot($context, $record['coordinator']);
        borkLayoutScreen($context, ['-X', 'layout', 'select', $record['screen']['backup']]);
        borkLayoutScreen($context, ['-X', 'layout', 'select', $record['screen']['working']]);
        if ($saved['panes'] !== $record['original']['panes'] || $saved['focus'] !== $record['original']['focus']) {
            borkLayoutScreen($context, ['-X', 'layout', 'select', $record['screen']['backup']]);
            throw new RuntimeException('Original Screen saved layout differs from live arrangement; original arrangement restored, retain journal for reconciliation.');
        }
    }
    $record['pending'] = null;
    return $record;
}

/** Create one ordinary shell placeholder in a new region of the same display. */
function borkLayoutScreenSplit(array $record, array $operation): string
{
    $context = $record['context'];
    $parent = $record['resources'][$operation['parent']]['id'];
    try {
        borkLayoutScreenFocus($context, $parent);
        borkLayoutScreen($context, array_merge(['-X', 'split'], $operation['direction'] === 'right' ? ['-v'] : []));
        borkLayoutScreen($context, ['-X', 'focus', 'next']);
        $pidfile = $record['record'] . '.' . str_replace(':', '-', $operation['new']) . '.pid';
        if (file_exists($pidfile)) {
            throw new RuntimeException('Screen placeholder identity file exists; reconcile pending split.');
        }
        $shell = 'echo $$ > ' . escapeshellarg($pidfile) . '; exec /bin/sh';
        borkLayoutScreen($context, ['-X', 'screen', '-t', $record['run_id'] . ':' . $operation['new'], '/bin/sh', '-c', $shell]);
        $id = explode(' ', borkLayoutScreen($context, ['-Q', 'number']), 2)[0];
        borkLayoutScreen($context, ['-X', 'resize', $operation['direction'] === 'right' ? '-h' : '-v', (string) ($operation['size'] + 1)]);
        foreach ($record['original']['panes'] as $oldId => $pane) {
            if ((string) $oldId !== $record['coordinator']) {
                borkLayoutScreenFocus($context, (string) $oldId);
                borkLayoutScreen($context, ['-X', 'resize', '-h', (string) ($pane['width'] + 1)]);
                borkLayoutScreen($context, ['-X', 'resize', '-v', (string) ($pane['height'] + 1)]);
            }
        }
        return $id;
    } finally {
        borkLayoutScreenFocus($context, $record['original']['focus']);
    }
}

/** Reapply planned leaf dimensions after Screen equalizes split siblings. */
function borkLayoutScreenSize(array $record): void
{
    $context = $record['context'];
    try {
        foreach ($record['resources'] as $role => $resource) {
            borkLayoutScreenFocus($context, $resource['id']);
            $slot = $record['plan']['slots'][$role];
            if ($role === 'coordinator' || str_starts_with($role, 'review:')) {
                borkLayoutScreen($context, ['-X', 'resize', '-h', (string) ($slot['width'] + 1)]);
            }
            if (str_starts_with($role, 'master:') || str_starts_with($role, 'review:')) {
                borkLayoutScreen($context, ['-X', 'resize', '-v', (string) ($slot['height'] + 1)]);
            }
        }
    } finally {
        borkLayoutScreenFocus($context, $record['original']['focus']);
    }
}

/** Verify that the owned Screen placeholder is still its original idle shell. */
function borkLayoutScreenIdle(array $record, array $resource): int
{
    $key = array_search($resource['id'], array_column($record['resources'], 'id'), true);
    $role = array_keys($record['resources'])[$key];
    $pidfile = $record['record'] . '.' . str_replace(':', '-', $role) . '.pid';
    $pid = (int) @file_get_contents($pidfile);
    if ($pid < 1 || trim(execute(['ps', '-p', (string) $pid, '-o', 'comm='])) !== 'sh') {
        throw new RuntimeException('Screen placeholder is no longer its original shell.');
    }
    $title = borkLayoutScreen($record['context'], ['-p', $resource['id'], '-Q', 'title']);
    if ($title !== $record['run_id'] . ':' . $role) {
        throw new RuntimeException('Screen window ownership title changed; preserve its occupant.');
    }
    return $pid;
}

/** Restore the saved full layout before removing only this run's shell windows. */
function borkLayoutScreenCleanup(array $record, string $path): array
{
    $context = $record['context'];
    $record['pending'] = ['restore_layout' => $record['screen']['backup']];
    borkLayoutWrite($path, $record);
    borkLayoutScreen($context, ['-X', 'layout', 'select', $record['screen']['backup']]);
    foreach ($record['resources'] as $role => $resource) {
        if ($role !== 'coordinator') {
            borkLayoutScreen($context, ['-p', $resource['id'], '-X', 'kill']);
            unset($record['resources'][$role]);
        }
    }
    $snapshot = borkLayoutScreenSnapshot($context, $record['coordinator']);
    if ($snapshot['panes'] !== $record['original']['panes'] || $snapshot['focus'] !== $record['original']['focus']) {
        throw new RuntimeException('Screen saved layout restoration differs from original.');
    }
    /* Selecting the original layout before removing backups preserves its active pointer. */
    if (preg_match('/^This is layout ([0-9]+) \(/', $record['screen']['original_layout'], $match)) {
        borkLayoutScreen($context, ['-X', 'layout', 'select', $match[1]]);
        $restored = borkLayoutScreenSnapshot($context, $record['coordinator']);
        if ($restored['panes'] !== $record['original']['panes'] || $restored['focus'] !== $record['original']['focus']) {
            borkLayoutScreen($context, ['-X', 'layout', 'select', $record['screen']['backup']]);
            throw new RuntimeException('Original saved layout differs from initial live arrangement; backup restored and retained for explicit reconciliation.');
        }
        borkLayoutScreen($context, ['-X', 'layout', 'remove', $record['screen']['working']]);
        borkLayoutScreen($context, ['-X', 'layout', 'remove', $record['screen']['backup']]);
    } else {
        borkLayoutScreen($context, ['-X', 'layout', 'remove', $record['screen']['working']]);
        borkLayoutScreen($context, ['-X', 'layout', 'remove', $record['screen']['backup']]);
    }
    $record['pending'] = null;
    $record['state'] = 'cleaned';
    borkLayoutWrite($path, $record);
    return ['state' => 'cleaned', 'coordinator' => $record['coordinator']];
}

/** Confirm one asynchronous Screen control without resubmitting it. */
function borkLayoutScreenMessage(array $context, callable $predicate): string
{
    $deadline = microtime(true) + 3;
    do {
        $message = borkLayoutScreen($context, ['-Q', 'lastmsg'], false);
        if ($predicate($message)) {
            return $message;
        }
        usleep(10000);
    } while (microtime(true) < $deadline);
    throw new RuntimeException('Screen did not confirm control completion; preserve pending intent.');
}
