<?php

declare(strict_types=1);

require_once __DIR__ . '/scheduler.php';

/** Read a regular JSON input file. */
function readInput(string $path): array
{
    if (!is_file($path) || is_link($path)) {
        throw new RuntimeException('Expected a regular input file.');
    }
    $data = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($data)) {
        throw new RuntimeException('Expected JSON object.');
    }
    return $data;
}

/** Require a nonempty text field. */
function field(array $data, string $key): string
{
    if (!isset($data[$key]) || !is_string($data[$key]) || $data[$key] === '') {
        throw new RuntimeException('Missing string: ' . $key);
    }
    return $data[$key];
}

/** Execute an argument array without shell interpolation. */
function execute(array $args): string
{
    $errors = fopen('php://temp', 'w+');
    $process = proc_open($args, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => $errors], $pipes);
    if (!is_resource($process)) {
        fclose($errors);
        throw new RuntimeException('Unable to start command.');
    }
    fclose($pipes[0]);
    $output = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    $code = proc_close($process);
    fclose($errors);
    if ($code !== 0) {
        throw new RuntimeException('tmux command failed; reconcile before retrying.');
    }
    return trim($output);
}

/** Call tmux on the selected socket, supporting isolated test servers. */
function tmux(array $data, array $args): string
{
    $prefix = ['tmux'];
    if (isset($data['socket'])) {
        $prefix = array_merge($prefix, ['-L', field($data, 'socket')]);
    }
    return execute(array_merge($prefix, $args));
}

/** Quote only the helper invocation used by tmux's POSIX shell. */
function runnerCommand(string $input): string
{
    return escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg(__FILE__) . ' run ' . escapeshellarg($input);
}

/** Launch one master session, retaining its pane after process exit. */
function launch(array $data, string $inputPath): array
{
    $cwd = field($data, 'cwd');
    if (!is_dir($cwd)) {
        throw new RuntimeException('Working directory missing.');
    }
    $role = field($data, 'role');
    if ($role !== 'master') {
        throw new RuntimeException('Only master sessions may be launched.');
    }
    $job = readInput(field($data, 'job'));
    validateJob($job);
    $bootstrap = escapeshellarg(PHP_BINARY) . ' -r ' . escapeshellarg('sleep(60);');
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
    tmux($data, ['respawn-pane', '-k', '-t', $pane, '-c', $cwd, runnerCommand($inputPath)]);
    return ['session' => $session, 'pane' => $pane, 'role' => $role];
}

/** Validate a provider command without executing it or interpreting credentials. */
function validateJob(array $job): void
{
    $args = $job['argv'] ?? null;
    if (!is_array($args) || !$args || !is_string($args[0]) || !is_executable($args[0])) {
        throw new RuntimeException('CLI executable is unavailable.');
    }
    foreach ($args as $arg) {
        if (!is_string($arg) || str_contains($arg, "\0")) {
            throw new RuntimeException('CLI arguments must be strings without NUL bytes.');
        }
    }
    field($job, 'exit_record');
}

/** Run the selected agent with the pane's actual terminal streams. */
function runPane(array $launch): int
{
    $job = readInput(field($launch, 'job'));
    validateJob($job);
    $record = field($job, 'exit_record');
    if (file_exists($record) || is_link($record) || !is_dir(dirname($record))) {
        throw new RuntimeException('Exit record exists or directory is missing.');
    }
    $process = proc_open($job['argv'], [0 => STDIN, 1 => STDOUT, 2 => STDERR], $pipes, field($launch, 'cwd'));
    if (!is_resource($process)) {
        throw new RuntimeException('Unable to start agent.');
    }
    $code = proc_close($process);
    $temp = tempnam(dirname($record), '.exit-');
    if ($temp === false || file_put_contents($temp, json_encode(['exit_code' => $code, 'time' => gmdate('c')], JSON_THROW_ON_ERROR)) === false || !rename($temp, $record)) {
        throw new RuntimeException('Exit record publication failed.');
    }
    return $code;
}

try {
    $mode = $argv[1] ?? '';
    $path = realpath($argv[2] ?? '');
    if ($path === false) {
        throw new RuntimeException('Usage: php tmux.php schedule|launch|run input.json');
    }
    $input = readInput($path);
    if ($mode === 'run') {
        exit(runPane($input));
    }
    if ($mode === 'schedule') {
        $result = schedule($input);
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
