<?php

declare(strict_types=1);

require_once __DIR__ . '/scheduler.php';
require_once __DIR__ . '/terminal.php';

/** Call tmux on the selected socket, supporting isolated test servers. */
function tmux(array $data, array $args): string
{
    $prefix = ['tmux'];
    if (isset($data['socket_path'], $data['socket'])) {
        throw new RuntimeException('Supply either socket_path or a named socket, not both.');
    }
    if (isset($data['socket_path'])) {
        $prefix = array_merge($prefix, ['-S', field($data, 'socket_path')]);
    } elseif (isset($data['socket'])) {
        $prefix = array_merge($prefix, ['-L', field($data, 'socket')]);
    }
    return execute(array_merge($prefix, $args));
}

/** Launch one role session, retaining its pane after process exit. */
function launch(array $data, string $inputPath): array
{
    $cwd = field($data, 'cwd');
    if (!is_dir($cwd)) {
        throw new RuntimeException('Working directory missing.');
    }
    $role = field($data, 'role');
    if (!in_array($role, ['master', 'review', 'fix'], true)) {
        throw new RuntimeException('Only master, review or fix sessions may be launched.');
    }
    $job = readInput(field($data, 'job'));
    validateJob($job);
    $shell = $data['shell'] ?? 'posix';
    $bootstrap = terminalCommand([PHP_BINARY, '-r', 'sleep(60);'], $shell);
    $runner = runnerCommand($inputPath, $shell);
    $name = field($data, 'session_name');
    if (!preg_match('/^[a-zA-Z0-9_-]+$/', $name)) {
        throw new RuntimeException('Unsafe session name.');
    }
    $pane = tmux($data, ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', $name, '-c', $cwd, $bootstrap]);
    tmux($data, ['set-option', '-p', '-t', $pane, 'remain-on-exit', 'on']);
    tmux($data, ['set-option', '-p', '-t', $pane, '@bork-role', $role]);
    tmux($data, ['select-pane', '-t', $pane, '-T', 'bork-' . $role]);
    tmux($data, ['set-option', '-w', '-t', $pane, 'pane-border-status', 'top']);
    tmux($data, ['set-option', '-w', '-t', $pane, 'pane-border-format', '#{pane_title}']);
    $session = tmux($data, ['display-message', '-p', '-t', $pane, '#{session_name}']);
    tmux($data, ['respawn-pane', '-k', '-t', $pane, '-c', $cwd, $runner]);
    return ['session' => $session, 'pane' => $pane, 'role' => $role];
}

try {
    $mode = $argv[1] ?? '';
    $path = realpath($argv[2] ?? '');
    if ($path === false) {
        throw new RuntimeException('Usage: php tmux.php schedule|command|launch|run input.json');
    }
    $input = readInput($path);
    if ($mode === 'run') {
        exit(runPane($input));
    }
    if ($mode === 'schedule') {
        $result = schedule($input);
    } elseif ($mode === 'command') {
        $result = ['command' => runnerCommand($path, field($input, 'shell'))];
    } elseif ($mode === 'launch') {
        $result = launch($input, $path);
    } else {
        throw new RuntimeException('Unknown mode.');
    }
    echo json_encode(['ok' => true, 'result' => $result], JSON_THROW_ON_ERROR) . "\n";
} catch (Throwable $error) {
    echo json_encode(['ok' => false, 'event' => 'blocked', 'error' => $error->getMessage()], JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
    exit(1);
}
