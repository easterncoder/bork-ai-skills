<?php

declare(strict_types=1);

/** Use the inherited Herdr session without selecting a focused or remote session. */
function borkLayoutHerdr(array $context, array $args): array
{
    if (getenv('HERDR_ENV') !== '1') {
        throw new RuntimeException('Herdr layout requires verified inherited HERDR_ENV=1 membership.');
    }
    $reply = json_decode(execute(array_merge(['herdr'], $args)), true, 512, JSON_THROW_ON_ERROR);
    if (isset($reply['error']) || !is_array($reply['result'] ?? null)) {
        throw new RuntimeException('Herdr response lacks verified result identity.');
    }
    return $reply['result'];
}

/** Normalize the documented Herdr pane-layout response. */
function borkLayoutHerdrSnapshot(array $context, string $coordinator): array
{
    $reply = borkLayoutHerdr($context, ['pane', 'layout', '--pane', $coordinator]);
    $layout = $reply['layout'] ?? $reply;
    if (($layout['zoomed'] ?? true) !== false || !is_array($layout['panes'] ?? null)) {
        throw new RuntimeException('Unusable or zoomed Herdr layout snapshot.');
    }
    $panes = [];
    foreach ($layout['panes'] as $pane) {
        $id = field($pane, 'pane_id');
        $panes[$id] = array_merge($pane['rect'], ['id' => $id, 'window' => field($layout, 'tab_id'), 'session' => field($layout, 'workspace_id')]);
    }
    if (!isset($panes[$coordinator])) {
        throw new RuntimeException('Herdr coordinator is absent from its recorded tab.');
    }
    return ['panes' => $panes, 'focus' => field($layout, 'focused_pane_id')];
}

/** Check exact ratio and background split controls before mutation. */
function borkLayoutHerdrCapabilities(array $context): array
{
    $help = execute(['herdr', 'pane', 'split', '--help']);
    foreach (['--ratio', '--no-focus', '--pane', '--cwd'] as $flag) {
        if (!str_contains($help, $flag)) {
            throw new RuntimeException('Missing Herdr layout capability: ' . $flag);
        }
    }
    return ['version' => execute(['herdr', '--version']), 'split_help_sha256' => hash('sha256', $help)];
}

/** Split the exact owned subtree without changing Herdr focus. */
function borkLayoutHerdrSplit(array $record, array $operation): string
{
    $parent = $record['resources'][$operation['parent']]['id'];
    $snapshot = borkLayoutHerdrSnapshot($record['context'], $record['coordinator']);
    $axis = $operation['direction'] === 'right' ? 'width' : 'height';
    $total = $snapshot['panes'][$parent][$axis];
    /* Request the retained child's share; verify actual rectangles after creation. */
    $ratio = ($total - $operation['size'] - 1) / ($total - 1);
    $reply = borkLayoutHerdr($record['context'], ['pane', 'split', '--pane', $parent, '--direction', $operation['direction'],
        '--ratio', (string) $ratio, '--cwd', $record['cwd'], '--no-focus']);
    return field($reply['pane'] ?? [], 'pane_id');
}
