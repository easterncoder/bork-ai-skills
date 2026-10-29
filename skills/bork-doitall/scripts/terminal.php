<?php

declare(strict_types=1);

require_once __DIR__ . '/provider-command.php';

/** Quote a command for the verified terminal shell, independent of PHP's OS. */
function terminalCommand(array $args, string $shell): string
{
    if (!in_array($shell, ['posix', 'powershell', 'cmd'], true)) {
        throw new RuntimeException('Unsupported terminal shell.');
    }
    $quoted = [];
    foreach ($args as $arg) {
        if (!is_string($arg) || preg_match('/[\x00\r\n]/', $arg)) {
            throw new RuntimeException('Invalid terminal command argument.');
        }
        if ($shell === 'cmd') {
            if (strpbrk($arg, '"%!') !== false) {
                throw new RuntimeException('Argument cannot be represented safely in cmd; use a verified PowerShell or POSIX shell.');
            }
            $quoted[] = '"' . $arg . '"';
        } else {
            $escaped = $shell === 'powershell' ? str_replace("'", "''", $arg) : str_replace("'", "'\"'\"'", $arg);
            $quoted[] = "'" . $escaped . "'";
        }
    }
    return ($shell === 'powershell' ? '& ' : '') . implode(' ', $quoted);
}

/** Build the shared runner invocation for the destination pane's shell. */
function runnerCommand(string $input, string $shell = 'posix'): string
{
    return terminalCommand([PHP_BINARY, __DIR__ . '/tmux.php', 'run', $input], $shell);
}

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
function execute(array $args, array $acceptedCodes = [0], ?array $environment = null): string
{
    $errors = fopen('php://temp', 'w+');
    $process = proc_open($args, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => $errors], $pipes, null, $environment, ['bypass_shell' => true]);
    if (!is_resource($process)) {
        fclose($errors);
        throw new RuntimeException('Unable to start command.');
    }
    fclose($pipes[0]);
    $output = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    $code = proc_close($process);
    fclose($errors);
    if (!in_array($code, $acceptedCodes, true)) {
        throw new RuntimeException('Terminal command failed; reconcile before retrying.');
    }
    return trim($output);
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
    validateProviderCommand($args);
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
    /* Keep the runner alive to record terminal interrupts delivered to its child. */
    if (function_exists('pcntl_signal')) {
        pcntl_signal(SIGINT, static function (): void {}, false);
    }
    $process = proc_open($job['argv'], [0 => STDIN, 1 => STDOUT, 2 => STDERR], $pipes, field($launch, 'cwd'), null, ['bypass_shell' => true]);
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

