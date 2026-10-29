<?php

declare(strict_types=1);

/** Verify the exact live Screen window against its ancestral process environment. */
function detectScreenContext(callable $env, callable $run, callable $ancestor): array
{
    $session = $env('STY');
    $window = $env('WINDOW');
    if (($session === false || $session === '') && ($window === false || $window === '')) {
        return ['active' => false];
    }
    if (!is_string($session) || !preg_match('/^([1-9][0-9]*)\.[^\s\/]+$/D', $session, $match)
        || !is_string($window) || !ctype_digit($window)) {
        throw new RuntimeException('Explicit Screen context is incomplete; restore STY and WINDOW in the live window.');
    }
    $server = (int) $match[1];
    if (!$ancestor($server)) {
        throw new RuntimeException('Explicit Screen session belongs to another process; reconcile membership.');
    }
    $reply = $run(['screen', '-S', $session, '-p', $window, '-Q', 'number']);
    if (!preg_match('/^' . preg_quote($window, '/') . ' \(/', $reply)) {
        throw new RuntimeException('Explicit Screen window is stale.');
    }
    /* Screen exposes no window PID query; procfs binds the window to its live child. */
    $shell = null;
    foreach (explode("\n", $run(['ps', '-eo', 'pid=,ppid='])) as $line) {
        if (!preg_match('/^\s*(\d+)\s+(\d+)\s*$/', $line, $child) || (int) $child[2] !== $server || !$ancestor((int) $child[1])) {
            continue;
        }
        $raw = @file_get_contents('/proc/' . $child[1] . '/environ');
        if ($raw !== false && in_array('STY=' . $session, explode("\0", $raw), true)
            && in_array('WINDOW=' . $window, explode("\0", $raw), true)) {
            $shell = (int) $child[1];
        }
    }
    if ($shell === null) {
        throw new RuntimeException('Cannot verify Screen window ancestry and environment via local procfs; reconcile caller context.');
    }
    return ['active' => true, 'session_id' => $session, 'pane_id' => $window, 'socket' => $session, 'shell_pid' => $shell, 'socket_dir' => $env('SCREENDIR') ?: null];
}
