<?php

declare(strict_types=1);

/** Keep all tmux commands on the explicitly selected server. */
function borkLayoutTmux(array $context, array $args): string
{
    $prefix = ['tmux'];
    if (isset($context['socket'], $context['socket_path'])) {
        throw new RuntimeException('Supply one tmux socket selector.');
    }
    foreach (['socket' => '-L', 'socket_path' => '-S'] as $key => $flag) {
        if (isset($context[$key])) {
            $prefix = array_merge($prefix, [$flag, field($context, $key)]);
        }
    }
    return execute(array_merge($prefix, $args));
}

/** Inspect actual pane geometry, creation identity, focus and ownership. */
function borkLayoutTmuxSnapshot(array $context, string $coordinator): array
{
    $format = '#{pane_id}|#{window_id}|#{session_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{pane_active}|#{pane_pid}|#{@bork-layout}|#{@bork-placement}|#{pane_current_command}|#{pane_dead}';
    $output = borkLayoutTmux($context, ['list-panes', '-t', $coordinator, '-F', $format]);
    $panes = [];
    $focus = null;
    foreach (explode("\n", $output) as $line) {
        $parts = explode('|', $line);
        if (count($parts) !== 13 || !preg_match('/^%[0-9]+$/D', $parts[0])) {
            throw new RuntimeException('Cannot verify tmux pane snapshot.');
        }
        [$id, $window, $session, $x, $y, $width, $height, $active, $pid, $owner, $placement, $command, $dead] = $parts;
        $panes[$id] = ['id' => $id, 'window' => $window, 'session' => $session, 'x' => (int) $x, 'y' => (int) $y,
            'width' => (int) $width, 'height' => (int) $height, 'pid' => (int) $pid, 'owner' => $owner, 'placement' => $placement, 'command' => $command, 'dead' => $dead === '1'];
        if ($active === '1') {
            $focus = $id;
        }
    }
    if (!isset($panes[$coordinator]) || $focus === null) {
        throw new RuntimeException('Recorded coordinator or focus is missing from its original tmux window.');
    }
    return ['panes' => $panes, 'focus' => $focus];
}

/** Resolve installed split support without creating a pane. */
function borkLayoutTmuxCapabilities(array $context): array
{
    $commands = borkLayoutTmux($context, ['list-commands']);
    foreach (['split-window', 'respawn-pane', 'list-panes', 'kill-pane'] as $command) {
        if (!str_contains($commands, $command)) {
            throw new RuntimeException('Missing tmux capability: ' . $command);
        }
    }
    if (!preg_match('/split-window[^\n]*\[-[^\]]*d/', $commands)) {
        throw new RuntimeException('tmux lacks background split support.');
    }
    return ['version' => borkLayoutTmux($context, ['-V']), 'commands_sha256' => hash('sha256', $commands)];
}

/** Split only the recorded parent, using returned identity and detached focus. */
function borkLayoutTmuxSplit(array $record, array $operation): string
{
    $context = $record['context'];
    $parent = $record['resources'][$operation['parent']]['id'];
    $id = borkLayoutTmux($context, ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', $parent,
        $operation['direction'] === 'right' ? '-h' : '-v', '-l', (string) $operation['size'], '-c', $record['cwd'], 'exec /bin/sh']);
    if (!preg_match('/^%[0-9]+$/D', $id)) {
        throw new RuntimeException('Split response lacks a unique tmux pane ID; reconcile pending intent.');
    }
    borkLayoutTmux($context, ['set-option', '-p', '-t', $id, '@bork-layout', $record['run_id']]);
    borkLayoutTmux($context, ['set-option', '-p', '-t', $id, '@bork-placement', $operation['new']]);
    return $id;
}
