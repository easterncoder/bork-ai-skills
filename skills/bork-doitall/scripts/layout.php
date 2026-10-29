<?php

declare(strict_types=1);

require_once __DIR__ . '/terminal.php';
require_once __DIR__ . '/layout-plan.php';
foreach (['tmux', 'herdr', 'hc-app', 'screen'] as $adapter) {
    require_once __DIR__ . '/layout-adapters/' . $adapter . '.php';
}

/** Atomically persist a layout journal outside disposable worktrees. */
function borkLayoutWrite(string $path, array $record): void
{
    if (is_link($path) || !is_dir(dirname($path))) {
        throw new RuntimeException('Layout record requires an existing persistent directory and no symlink.');
    }
    $temp = tempnam(dirname($path), '.layout-');
    if ($temp === false || file_put_contents($temp, json_encode($record, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR)) === false || !rename($temp, $path)) {
        throw new RuntimeException('Layout journal publication failed.');
    }
}

/** Read the selected driver's live snapshot without switching drivers. */
function borkLayoutSnapshot(array $record): array
{
    if ($record['driver'] === 'hc') {
        foreach ($record['resources'] ?? [] as $resource) {
            if (isset($resource['visible_terminal'])) {
                $record['context']['visible'][$resource['id']] = $resource['visible_terminal'];
            }
        }
    }
    return match ($record['driver']) {
        'tmux' => borkLayoutTmuxSnapshot($record['context'], $record['coordinator']),
        'herdr' => borkLayoutHerdrSnapshot($record['context'], $record['coordinator']),
        'hc' => borkLayoutAppSnapshot($record['context'], $record['coordinator']),
        'screen' => borkLayoutScreenSnapshot($record['context'], $record['coordinator']),
        default => throw new RuntimeException('Visual adapter has no verified geometry interface.'),
    };
}

/** Verify placement identity, surrounding panes, geometry and preserved focus. */
function borkLayoutVerify(array $record, bool $geometry = true, bool $rendered = true): array
{
    if (($record['pending'] ?? null) !== null) {
        throw new RuntimeException('Uncertain layout mutation requires reconciliation; do not repeat it.');
    }
    $snapshot = borkLayoutSnapshot($record);
    if ($snapshot['focus'] !== $record['original']['focus']) {
        throw new RuntimeException('User focus changed; pause background layout operations.');
    }
    foreach ($record['resources'] as $placement => $resource) {
        $pane = $snapshot['panes'][$resource['id']] ?? null;
        if ($pane === null || $pane['window'] !== $record['original']['panes'][$record['coordinator']]['window']) {
            throw new RuntimeException('Owned placement is missing or changed window.');
        }
        if ($record['driver'] === 'tmux' && $placement !== 'coordinator'
            && ($pane['owner'] !== $record['run_id'] || $pane['placement'] !== $placement)) {
            throw new RuntimeException('Pane ownership no longer matches this layout.');
        }
        if ($record['driver'] === 'hc' && $placement !== 'coordinator' && $geometry && $rendered
            && ($pane['cols'] < 35 || $pane['rows'] < 6)) {
            throw new RuntimeException('Rendered App terminal is below usable worker bounds; preserve layout for recovery.');
        }
        if ($record['driver'] === 'hc' && isset($resource['actual_cells']) && $geometry && $rendered
            && $resource['actual_cells'] !== [$pane['cols'], $pane['rows']]) {
            throw new RuntimeException('Rendered App geometry changed for ' . $placement . ': expected ' . json_encode($resource['actual_cells']) . ', observed ' . json_encode([$pane['cols'], $pane['rows']]) . '; reconcile resize before new claims.');
        }
        if ($geometry) {
            borkLayoutGeometry($record['plan']['slots'][$placement], $pane, $record['driver'] === 'herdr' ? 1 : 0);
        }
    }
    foreach ($record['original']['panes'] as $id => $pane) {
        if ((string) $id !== $record['coordinator']) {
            borkLayoutGeometry($pane, $snapshot['panes'][$id] ?? []);
        }
    }
    $ids = array_column($record['resources'], 'id');
    foreach ($snapshot['panes'] as $id => $pane) {
        if (!isset($record['original']['panes'][$id]) && !in_array((string) $id, $ids, true)) {
            throw new RuntimeException('An unrelated pane appeared; reconcile before modifying the layout.');
        }
    }
    return $snapshot;
}

/** Preflight a visual host and plan from its actual coordinator rectangle. */
function borkLayoutPreflight(array $input): array
{
    $driver = field($input, 'driver');
    if ($driver === 'hc' && ($input['visual_host'] ?? null) === null) {
        return ['supported' => true, 'visual' => false, 'reason' => 'Headless hc manages terminals. Visual arrangement requires a supported Herdr App interface.'];
    }
    $context = $input['context'] ?? [];
    $capability = match ($driver) {
        'tmux' => borkLayoutTmuxCapabilities($context),
        'herdr' => borkLayoutHerdrCapabilities($context),
        'hc' => borkLayoutAppCapabilities($context),
        'screen' => borkLayoutScreenCapabilities($context),
        default => throw new RuntimeException('Unsupported layout driver.'),
    };
    if (($capability['supported'] ?? true) === false) {
        return ['supported' => false, 'visual' => true, 'capability' => $capability];
    }
    if ($driver === 'screen') {
        $context = borkLayoutScreenContext($context, field($input, 'coordinator'));
    }
    $record = ['driver' => $driver, 'context' => $context, 'coordinator' => field($input, 'coordinator')];
    $snapshot = borkLayoutSnapshot($record);
    return ['supported' => true, 'visual' => true, 'capability' => $capability, 'snapshot' => $snapshot, 'context' => $context,
        'plan' => borkLayoutPlan($input['concurrency'] ?? 1, array_intersect_key($snapshot['panes'][$record['coordinator']], array_flip(['x', 'y', 'width', 'height'])), $driver === 'herdr' ? 0 : 1)];
}

/** Provision placeholders once, journaling every split before mutation. */
function borkLayoutCreate(array $input): array
{
    $path = field($input, 'record');
    if (file_exists($path) || is_link($path)) {
        throw new RuntimeException('Layout record exists; inspect it instead of creating another layout.');
    }
    $preflight = borkLayoutPreflight($input);
    if (!$preflight['supported']) {
        throw new RuntimeException($preflight['capability']['reason']);
    }
    if (!$preflight['visual']) {
        return $preflight;
    }
    $run = field($input, 'run_id');
    if (!preg_match('/^[a-zA-Z0-9_-]+$/D', $run) || !is_dir(field($input, 'cwd'))) {
        throw new RuntimeException('Invalid run identity or working directory.');
    }
    $record = array_merge($input, ['version' => 1, 'state' => 'creating', 'context' => $preflight['context'],
        'plan' => $preflight['plan'], 'capability' => $preflight['capability'], 'original' => $preflight['snapshot'],
        'resources' => ['coordinator' => ['id' => $input['coordinator'], 'state' => 'protected']], 'pending' => null]);
    if ($record['driver'] === 'hc') {
        $record['context']['root_area'] = $record['original']['root_area'];
        $record['context']['core_id'] = $record['original']['tree']['core_id'];
    }
    borkLayoutWrite($path, $record);
    if ($record['driver'] === 'screen') {
        $record = borkLayoutScreenPrepare($record);
        borkLayoutWrite($path, $record);
    }
    foreach ($record['plan']['operations'] as $index => $operation) {
        $record['pending'] = ['operation' => $operation, 'index' => $index, 'before' => borkLayoutSnapshot($record)];
        borkLayoutWrite($path, $record);
        $id = match ($record['driver']) {
            'tmux' => borkLayoutTmuxSplit($record, $operation),
            'herdr' => borkLayoutHerdrSplit($record, $operation),
            'hc' => borkLayoutAppSplit($record, $operation),
            'screen' => borkLayoutScreenSplit($record, $operation),
        };
        $created = borkLayoutSnapshot($record)['panes'][$id] ?? null;
        if ($created === null) {
            throw new RuntimeException('Returned split pane cannot be verified; preserve pending intent.');
        }
        $record['resources'][$operation['new']] = ['id' => $id, 'state' => 'placeholder',
            'idle_pid' => $created['pid'] ?? null, 'idle_command' => $created['command'] ?? null,
            'terminal' => $created['terminal'] ?? null, 'created_ms' => $created['created_ms'] ?? null];
        $record['pending'] = null;
        borkLayoutWrite($path, $record);
        borkLayoutVerify($record, false);
    }
    if ($record['driver'] === 'screen') {
        borkLayoutScreenSize($record);
    }
    if ($record['driver'] === 'hc') {
        $snapshot = borkLayoutAppStable($record);
        foreach ($record['resources'] as &$resource) {
            $pane = $snapshot['panes'][$resource['id']];
            $resource['actual_cells'] = [$pane['cols'], $pane['rows']];
        }
        unset($resource);
    }
    borkLayoutVerify($record);
    $record['state'] = 'ready';
    borkLayoutWrite($path, $record);
    return $record;
}

/** Refuse to replace or close a placeholder occupied by an unowned process. */
function borkLayoutIdle(array $record, string $key): void
{
    $resource = $record['resources'][$key];
    $snapshot = borkLayoutSnapshot($record);
    $pane = $snapshot['panes'][$resource['id']];
    if ($record['driver'] === 'tmux') {
        if ($pane['dead']) {
            return;
        }
        if ($pane['pid'] !== $resource['idle_pid']) {
            throw new RuntimeException('Placeholder process identity changed; preserve its occupant.');
        }
        $pid = $pane['pid'];
        $command = ltrim(trim(execute(['ps', '-p', (string) $pid, '-o', 'comm='])), '-');
        if (!in_array($command, ['sh', 'dash'], true)) {
            throw new RuntimeException('Placeholder is not its original idle shell.');
        }
    } elseif ($record['driver'] === 'hc') {
        $terminal = borkLayoutAppRpc($record['context'], 'terminal.get', ['terminal' => $resource['terminal']]);
        if (($terminal['created_ms'] ?? null) !== $resource['created_ms'] || ($terminal['state'] ?? null) !== 'live'
            || ($terminal['argv'] ?? null) !== ['/bin/sh']) {
            throw new RuntimeException('App placeholder terminal identity or shell changed.');
        }
        $pid = $terminal['pid'];
        if (!in_array(trim(execute(['ps', '-p', (string) $pid, '-o', 'comm='])), ['sh', 'dash'], true)) {
            throw new RuntimeException('App placeholder is occupied by another foreground process.');
        }
    } elseif ($record['driver'] === 'screen') {
        $pid = borkLayoutScreenIdle($record, $resource);
    } else {
        $info = borkLayoutHerdr($record['context'], ['pane', 'process-info', '--pane', $resource['id']]);
        $info = $info['process_info'] ?? $info;
        $foreground = $info['foreground_processes'] ?? [];
        if (!is_int($info['shell_pid'] ?? null) || count($foreground) !== 1 || ($foreground[0]['pid'] ?? null) !== $info['shell_pid']) {
            throw new RuntimeException('Placeholder is not an available foreground shell.');
        }
        $pid = $info['shell_pid'];
    }
    foreach (explode("\n", execute(['ps', '-eo', 'pid=,ppid='])) as $line) {
        $fields = preg_split('/\s+/', trim($line));
        if (count($fields) === 2 && (int) $fields[1] === $pid) {
            throw new RuntimeException('Placeholder has active child processes; preserve them.');
        }
    }
}

/** Reserve a stable role placement without starting or duplicating a worker. */
function borkLayoutClaim(array $input, array $record): array
{
    if ($record['state'] !== 'ready') {
        throw new RuntimeException('Layout is not ready for a launch.');
    }
    borkLayoutVerify($record);
    $role = field($input, 'role');
    $slot = $input['slot'] ?? null;
    if (!in_array($role, ['master', 'review', 'fix'], true) || !is_int($slot) || $slot < 1 || $slot > $record['plan']['concurrency']) {
        throw new RuntimeException('Invalid role or concurrency slot.');
    }
    $key = $role . ':' . $slot;
    if ($record['resources'][$key]['state'] !== 'placeholder') {
        throw new RuntimeException('Placement is already claimed; reconcile its previous worker.');
    }
    borkLayoutIdle($record, $key);
    $record['resources'][$key] += ['task_id' => field($input, 'task_id'), 'target_id' => field($input, 'target_id')];
    $record['resources'][$key]['state'] = 'claimed';
    borkLayoutWrite(field($input, 'record'), $record);
    return $record['resources'][$key];
}

/** Release a placement only after its result and stopped descendants are verified. */
function borkLayoutRelease(array $input, array $record): array
{
    if (($input['results_verified'] ?? false) !== true || ($input['descendants_stopped'] ?? false) !== true || ($input['worker_stopped'] ?? false) !== true) {
        throw new RuntimeException('Release requires accepted results and stopped worker/descendants.');
    }
    borkLayoutVerify($record);
    $key = field($input, 'placement');
    $resource = $record['resources'][$key] ?? [];
    if (($resource['state'] ?? null) !== 'claimed' || ($resource['task_id'] ?? null) !== field($input, 'task_id')) {
        throw new RuntimeException('Release identity does not match the claimed task.');
    }
    $resultPath = field($input, 'result_path');
    $result = readInput($resultPath);
    if (!in_array($result['status'] ?? null, ['complete', 'blocked'], true)) {
        throw new RuntimeException('Release requires a durable terminal role result.');
    }
    $record['history'][] = ['placement' => $key, 'resource' => $resource, 'result_path' => $resultPath];
    $record['resources'][$key] = array_intersect_key($resource, array_flip(['id', 'idle_pid', 'idle_command', 'terminal', 'created_ms', 'actual_cells']));
    $record['resources'][$key]['state'] = 'placeholder';
    borkLayoutWrite(field($input, 'record'), $record);
    return $record['resources'][$key];
}

/** Remove only idle owned leaves, keeping the coordinator and all surrounding panes. */
function borkLayoutCleanup(array $input, array $record): array
{
    if (($input['results_verified'] ?? false) !== true || ($input['descendants_stopped'] ?? false) !== true) {
        throw new RuntimeException('Cleanup requires accepted results and stopped descendants.');
    }
    foreach ($record['resources'] as $key => $resource) {
        if ($key !== 'coordinator' && $resource['state'] !== 'placeholder') {
            throw new RuntimeException('A role is still claimed; release it after verifying worker shutdown.');
        }
    }
    borkLayoutVerify($record, false);
    foreach (array_keys($record['resources']) as $key) {
        if ($key !== 'coordinator') {
            borkLayoutIdle($record, $key);
        }
    }
    $path = field($input, 'record');
    $record['state'] = 'cleaning';
    borkLayoutWrite($path, $record);
    if ($record['driver'] === 'screen') {
        return borkLayoutScreenCleanup($record, $path);
    }
    foreach (array_reverse(array_keys($record['resources'])) as $key) {
        if ($key === 'coordinator') {
            continue;
        }
        $id = $record['resources'][$key]['id'];
        $record['pending'] = ['close' => $key, 'id' => $id];
        borkLayoutWrite($path, $record);
        if ($record['driver'] === 'tmux') {
            borkLayoutTmux($record['context'], ['kill-pane', '-t', $id]);
        } elseif ($record['driver'] === 'hc') {
            try {
                borkLayoutAppCommand($record['context'], 'pane.close', ['pane' => $id]);
                borkLayoutAppAwait($record['context'], $record['coordinator'], static fn (array $tree): bool => borkLayoutAppFind($tree['root'], $id) === null);
            } finally {
                borkLayoutAppRestoreFocus($record);
            }
        } else {
            borkLayoutHerdr($record['context'], ['pane', 'close', $id]);
        }
        unset($record['resources'][$key]);
        $record['pending'] = null;
        borkLayoutWrite($path, $record);
        borkLayoutVerify($record, false);
    }
    $snapshot = borkLayoutSnapshot($record);
    borkLayoutGeometry($record['original']['panes'][$record['coordinator']], $snapshot['panes'][$record['coordinator']], $record['driver'] === 'herdr' ? 1 : 0);
    $record['state'] = 'cleaned';
    borkLayoutWrite($path, $record);
    return ['state' => 'cleaned', 'coordinator' => $record['coordinator']];
}

/** Serialize mutations across target masters and concurrent goodcode owners. */
function borkLayoutAction(string $action, array $input): array
{
    if ($action === 'plan') {
        return borkLayoutPlan($input['concurrency'] ?? 1, $input['area'] ?? []);
    }
    if ($action === 'preflight') {
        return borkLayoutPreflight($input);
    }
    $path = field($input, 'record');
    $lock = fopen($path . '.lock', 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) {
        throw new RuntimeException('Cannot acquire layout journal lock.');
    }
    try {
        if ($action === 'create') {
            return borkLayoutCreate($input);
        }
        $record = readInput($path);
        return match ($action) {
            'inspect' => ['record' => $record, 'snapshot' => borkLayoutSnapshot($record)],
            'claim' => borkLayoutClaim($input, $record),
            'release' => borkLayoutRelease($input, $record),
            'bind' => borkLayoutAppBind($input, $record),
            'cleanup' => borkLayoutCleanup($input, $record),
            default => throw new RuntimeException('Unknown layout action.'),
        };
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    try {
        $result = borkLayoutAction($argv[1] ?? '', readInput($argv[2] ?? ''));
        echo json_encode(['ok' => true, 'result' => $result], JSON_THROW_ON_ERROR) . "\n";
    } catch (Throwable $error) {
        echo json_encode(['ok' => false, 'event' => 'blocked', 'error' => $error->getMessage()], JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
        exit(1);
    }
}
