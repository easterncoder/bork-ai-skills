<?php

declare(strict_types=1);

/** Keep app and core calls on the explicitly recorded local endpoints. */
function borkLayoutAppEnvironment(array $context): array
{
    $environment = getenv();
    foreach (['session' => 'HC_SESSION', 'app_home' => 'HERDR_APP_HOME'] as $key => $name) {
        if (isset($context[$key])) {
            $environment[$name] = field($context, $key);
        }
    }
    return $environment;
}

/** Read or call the documented newline JSON-RPC core interface. */
function borkLayoutAppRpc(array $context, string $method, array $params = []): array
{
    $args = ['hc', 'connect'];
    if (isset($context['session'])) {
        $args = array_merge($args, ['--session', field($context, 'session')]);
    }
    $error = fopen('php://temp', 'w+');
    $process = proc_open($args, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => $error], $pipes, null, borkLayoutAppEnvironment($context));
    if (!is_resource($process)) {
        throw new RuntimeException('Cannot reach recorded app core.');
    }
    fwrite($pipes[0], json_encode(['jsonrpc' => '2.0', 'id' => 1, 'method' => $method, 'params' => (object) $params], JSON_THROW_ON_ERROR) . "\n");
    fclose($pipes[0]);
    $output = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    $code = proc_close($process);
    fclose($error);
    $reply = json_decode(trim($output), true, 512, JSON_THROW_ON_ERROR);
    if ($code !== 0 || isset($reply['error']) || !is_array($reply['result'] ?? null)) {
        throw new RuntimeException('Core request failed; preserve layout intent and reconcile.');
    }
    return $reply['result'];
}

/** Invoke only public app controls, without starting or raising a window. */
function borkLayoutAppCommand(array $context, string $name, ?array $args = null): array
{
    $argv = $args === null ? ['herdr-app', $name] : ['herdr-app', 'do', $name, json_encode($args, JSON_THROW_ON_ERROR)];
    $reply = json_decode(execute($argv, [0], borkLayoutAppEnvironment($context)), true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($reply) || isset($reply['error'])) {
        throw new RuntimeException('App control failed; reconcile the saved mutation.');
    }
    return $reply;
}

/** Find a public split-tree node and its immediate siblings. */
function borkLayoutAppFind(array $node, string $id, ?array $parent = null): ?array
{
    if (($node['id'] ?? null) === $id) {
        return ['node' => $node, 'parent' => $parent];
    }
    foreach ($node['children'] ?? [] as $child) {
        $found = borkLayoutAppFind($child, $id, $node);
        if ($found !== null) {
            return $found;
        }
    }
    return null;
}

/** Resolve the exact active local tab from the complete public document. */
function borkLayoutAppTree(array $context, string $coordinator): array
{
    $server = borkLayoutAppRpc($context, 'server.status');
    if (isset($context['core_id']) && ($server['core']['id'] ?? null) !== $context['core_id']) {
        throw new RuntimeException('Recorded app core identity changed.');
    }
    $status = borkLayoutAppCommand($context, 'status');
    if (($status['overlays'] ?? []) !== [] || ($status['errors'] ?? []) !== []) {
        throw new RuntimeException('Resolve app overlays or errors before background layout changes.');
    }
    $document = borkLayoutAppRpc($context, 'doc.get', ['name' => 'herdr-app']);
    foreach ($document['value']['spaces'] ?? [] as $space) {
        foreach ($space['tabs'] ?? [] as $tab) {
            if (borkLayoutAppFind($tab['root'], $coordinator) !== null) {
                if ($space['id'] !== ($status['space'] ?? null) || $tab['id'] !== ($status['tab'] ?? null)) {
                    throw new RuntimeException('Coordinator is outside the active app space/tab.');
                }
                return ['root' => $tab['root'], 'tab' => $tab['id'], 'space' => $space['id'], 'status' => $status,
                    'version' => $document['version'], 'core_id' => $server['core']['id']];
            }
        }
    }
    throw new RuntimeException('Coordinator is absent from the recorded app document.');
}

/** Map weighted tree topology to logical cells, retaining actual terminal geometry. */
function borkLayoutAppWalk(array $context, array $node, array $area, array $tree, array &$panes): void
{
    if (($node['hidden'] ?? false) || !in_array($node['type'] ?? '', ['row', 'column', 'block'], true)) {
        throw new RuntimeException('Hidden/stack app nodes require an explicit supported geometry mapping.');
    }
    if ($node['type'] === 'block') {
        $terminal = field($node['content'] ?? [], 'terminal');
        $shown = $context['visible'][$node['id']] ?? $terminal;
        $actual = borkLayoutAppRpc($context, 'terminal.get', ['terminal' => $shown]);
        $panes[$node['id']] = $area + ['id' => $node['id'], 'window' => $tree['tab'], 'session' => $tree['space'],
            'terminal' => $terminal, 'cols' => $actual['cols'] ?? 0, 'rows' => $actual['rows'] ?? 0,
            'created_ms' => $actual['created_ms'] ?? null, 'node' => $node];
        return;
    }
    $children = $node['children'] ?? [];
    if (!$children) {
        throw new RuntimeException('App container has no measured leaves.');
    }
    $axis = $node['type'] === 'row' ? 'width' : 'height';
    $position = $node['type'] === 'row' ? 'x' : 'y';
    $weight = 0.0;
    foreach ($children as $child) {
        if (isset($child['size']['px']) || ($child['size']['weight'] ?? 1) <= 0) {
            throw new RuntimeException('Pixel-sized or nonpositive app splits require geometry reconciliation before layout.');
        }
        $weight += $child['size']['weight'] ?? 1;
    }
    $usable = $area[$axis] - count($children) + 1;
    $offset = 0;
    $cumulative = 0.0;
    foreach ($children as $index => $child) {
        $cumulative += $child['size']['weight'] ?? 1;
        $end = $index === count($children) - 1 ? $usable : (int) round($usable * $cumulative / $weight);
        $rect = array_replace($area, [$position => $area[$position] + $offset + $index, $axis => $end - $offset]);
        borkLayoutAppWalk($context, $child, $rect, $tree, $panes);
        $offset = $end;
    }
}

/** Snapshot public topology, stable bindings, live terminal cells and final focus. */
function borkLayoutAppSnapshot(array $context, string $coordinator): array
{
    $tree = borkLayoutAppTree($context, $coordinator);
    $area = $context['root_area'] ?? null;
    if ($area === null) {
        $leaf = borkLayoutAppFind($tree['root'], $coordinator)['node'];
        $actual = borkLayoutAppRpc($context, 'terminal.get', ['terminal' => field($leaf['content'] ?? [], 'terminal')]);
        $area = ['x' => 0, 'y' => 0, 'width' => $actual['cols'], 'height' => $actual['rows']];
        /* Recover root cell scale from a virtual unit tree and the measured coordinator. */
        $unit = [];
        borkLayoutAppWalk($context, $tree['root'], ['x' => 0, 'y' => 0, 'width' => 100000, 'height' => 100000], $tree, $unit);
        $area['width'] = (int) round($area['width'] * 100000 / $unit[$coordinator]['width']);
        $area['height'] = (int) round($area['height'] * 100000 / $unit[$coordinator]['height']);
    }
    $panes = [];
    borkLayoutAppWalk($context, $tree['root'], $area, $tree, $panes);
    return ['panes' => $panes, 'focus' => field($tree['status'], 'focused_pane'), 'tree' => $tree, 'root_area' => $area];
}

/** Resolve equivalent documented read, split, size and focus controls before mutation. */
function borkLayoutAppCapabilities(array $context = []): array
{
    $commands = borkLayoutAppCommand($context, 'commands');
    $names = array_column($commands, 'name');
    foreach (['pane.split', 'pane.close', 'pane.focus', 'layout.resize', 'terminal.show'] as $name) {
        if (!in_array($name, $names, true)) {
            throw new RuntimeException('Missing app layout command: ' . $name);
        }
    }
    return ['supported' => true, 'commands_sha256' => hash('sha256', json_encode($commands, JSON_THROW_ON_ERROR)),
        'focus' => 'Splits focus transiently; the saved pane is restored and checked on success and error.'];
}

/** Restore and verify the original app focus after public background controls. */
function borkLayoutAppRestoreFocus(array $record): void
{
    $context = $record['context'];
    borkLayoutAppCommand($context, 'pane.focus', ['pane' => $record['original']['focus']]);
    $status = borkLayoutAppCommand($context, 'status');
    if (($status['focused_pane'] ?? null) !== $record['original']['focus']) {
        throw new RuntimeException('Original app focus could not be restored; preserve pending intent.');
    }
}

/** Split an owned subtree and proportionally preserve its original sibling share. */
function borkLayoutAppSplit(array $record, array $operation): string
{
    $context = $record['context'];
    $parent = $record['resources'][$operation['parent']]['id'];
    $snapshot = borkLayoutAppSnapshot($context, $record['coordinator']);
    $found = borkLayoutAppFind($snapshot['tree']['root'], $parent);
    $axis = $operation['direction'] === 'right' ? 'width' : 'height';
    $orientation = $operation['direction'] === 'right' ? 'row' : 'column';
    $share = ($found['parent']['type'] ?? null) === $orientation ? ($found['node']['size']['weight'] ?? 1) : 1;
    $ratio = $operation['size'] / ($snapshot['panes'][$parent][$axis] - 1);
    try {
        $reply = borkLayoutAppCommand($context, 'pane.split', ['pane' => $parent, 'direction' => $operation['direction'], 'argv' => ['/bin/sh']]);
        $id = field($reply, 'pane');
        borkLayoutAppCommand($context, 'layout.resize', ['id' => $parent, 'weight' => $share * (1 - $ratio)]);
        borkLayoutAppCommand($context, 'layout.resize', ['id' => $id, 'weight' => $share * $ratio]);
        borkLayoutAppAwait($context, $record['coordinator'], static function (array $tree) use ($parent, $id, $share, $ratio): bool {
            $old = borkLayoutAppFind($tree['root'], $parent);
            $new = borkLayoutAppFind($tree['root'], $id);
            return $old !== null && $new !== null
                && abs(($old['node']['size']['weight'] ?? 1) - $share * (1 - $ratio)) < 0.00001
                && abs(($new['node']['size']['weight'] ?? 1) - $share * $ratio) < 0.00001;
        });
        return $id;
    } finally {
        borkLayoutAppRestoreFocus($record);
    }
}

/** Wait boundedly for asynchronous public document persistence, never replaying a mutation. */
function borkLayoutAppAwait(array $context, string $coordinator, callable $predicate): array
{
    $deadline = microtime(true) + 4;
    do {
        $tree = borkLayoutAppTree($context, $coordinator);
        if ($predicate($tree)) {
            return $tree;
        }
        usleep(50000);
    } while (microtime(true) < $deadline);
    throw new RuntimeException('App document persistence did not confirm mutation; preserve pending intent.');
}

/** Observe settled rendered terminal cells independently of logical weighted rectangles. */
function borkLayoutAppStable(array $record, bool $expected = false, ?callable $refresh = null): array
{
    $previous = null;
    $deadline = microtime(true) + 4;
    do {
        if ($refresh !== null) {
            $refresh();
        }
        $snapshot = borkLayoutSnapshot($record);
        $cells = array_map(static fn (array $pane): array => [$pane['cols'], $pane['rows']], $snapshot['panes']);
        $matches = true;
        if ($expected) {
            foreach ($record['resources'] as $resource) {
                $matches = $matches && ($cells[$resource['id']] === ($resource['actual_cells'] ?? $cells[$resource['id']]));
            }
        }
        if ($matches && $cells === $previous) {
            return $snapshot;
        }
        $previous = $cells;
        usleep(50000);
    } while (microtime(true) < $deadline);
    throw new RuntimeException('App rendered geometry did not settle; retain layout for reconciliation.');
}

/** Bind a claimed visible placement to its exact owned hc terminal or restore its shell. */
function borkLayoutAppBind(array $input, array $record): array
{
    if ($record['driver'] !== 'hc') {
        throw new RuntimeException('Visible terminal bindings require the recorded App adapter.');
    }
    borkLayoutVerify($record, true, false);
    $key = field($input, 'placement');
    $resource = $record['resources'][$key] ?? [];
    if (($resource['state'] ?? null) !== 'claimed' || ($resource['task_id'] ?? null) !== field($input, 'task_id')) {
        throw new RuntimeException('App binding does not match the claimed task.');
    }
    $args = ['pane' => $resource['id']];
    if (($input['show'] ?? true) === true) {
        $terminal = borkLayoutAppRpc($record['context'], 'terminal.get', ['terminal' => field($input, 'terminal_id')]);
        if (($terminal['created_ms'] ?? null) !== ($input['created_ms'] ?? null)
            || ($terminal['labels']['bork-run'] ?? null) !== $record['run_id']) {
            throw new RuntimeException('Visible App terminal ownership changed.');
        }
        $args['terminal'] = $input['terminal_id'];
    }
    try {
        borkLayoutAppCommand($record['context'], 'terminal.show', $args);
    } finally {
        borkLayoutAppRestoreFocus($record);
    }
    unset($record['resources'][$key]['visible_terminal']);
    if (isset($args['terminal'])) {
        $record['resources'][$key]['visible_terminal'] = $args['terminal'];
    }
    /* Reapply only the idempotent view binding while App incorporates the new core terminal. */
    borkLayoutAppStable($record, true, static function () use ($record, $args): void {
        try {
            borkLayoutAppCommand($record['context'], 'terminal.show', $args);
        } finally {
            borkLayoutAppRestoreFocus($record);
        }
    });
    borkLayoutVerify($record);
    borkLayoutWrite(field($input, 'record'), $record);
    return $record['resources'][$key];
}
