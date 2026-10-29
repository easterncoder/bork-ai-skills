<?php

declare(strict_types=1);

require_once __DIR__ . '/terminal.php';
require_once __DIR__ . '/layout.php';

/** Preserve a verified custom socket directory across detached tool boundaries. */
function screenExecute(array $data, array $args, array $codes = [0]): string
{
    $environment = null;
    if (isset($data['socket_dir'])) {
        $directory = field($data, 'socket_dir');
        if (!is_dir($directory) || realpath($directory) !== $directory) {
            throw new RuntimeException('Screen socket directory must be an existing absolute directory.');
        }
        $environment = array_replace(getenv(), ['SCREENDIR' => $directory]);
    }
    return execute($args, $codes, $environment);
}

/** Address one exact recorded Screen session and window without shell interpolation. */
function screenCommand(array $data, array $args): string
{
    $session = field($data, 'session');
    $window = field($data, 'pane');
    if (!preg_match('/^[1-9][0-9]*\.[a-zA-Z0-9_-]+$/D', $session) || !ctype_digit($window)) {
        throw new RuntimeException('Invalid recorded Screen identity.');
    }
    return screenExecute($data, array_merge(['screen', '-S', $session, '-p', $window], $args));
}

/** List local sessions while distinguishing an empty server from command failure. */
function screenSessions(array $data): string
{
    $output = screenExecute($data, ['screen', '-ls'], [0, 1]);
    if (!str_contains($output, 'No Sockets found') && !preg_match('/[0-9]+ Sockets? in /', $output)) {
        throw new RuntimeException('Cannot establish the local Screen session inventory.');
    }
    return $output;
}

/** Launch one isolated role session with retained dead windows and shared runner evidence. */
function launchScreen(array $data, string $path): array
{
    if (isset($data['layout_record'])) {
        $capability = borkLayoutScreenCapabilities();
        throw new RuntimeException($capability['reason']);
    }
    $role = field($data, 'role');
    $name = field($data, 'session_name');
    $cwd = field($data, 'cwd');
    if (!in_array($role, ['master', 'review', 'fix'], true) || !preg_match('/^[a-zA-Z0-9_-]+$/D', $name) || !is_dir($cwd)) {
        throw new RuntimeException('Invalid Screen role, session name or working directory.');
    }
    validateJob(readInput(field($data, 'job')));
    if (preg_match('/^\s*[1-9][0-9]*\.' . preg_quote($name, '/') . '\s/m', screenSessions($data))) {
        throw new RuntimeException('Screen session name already exists; reconcile ownership before launch.');
    }
    $config = $path . '.screenrc';
    $handle = @fopen($config, 'x');
    if ($handle === false) {
        throw new RuntimeException('Screen configuration exists; reconcile the prior launch.');
    }
    fwrite($handle, "startup_message off\nzombie kr\ndefscrollback 10000\n");
    fclose($handle);
    /* -m creates a separate session even when invoked from another Screen window. */
    screenExecute($data, ['screen', '-dmS', $name, '-c', $config, '-t', 'bork-' . $role, PHP_BINARY, __DIR__ . '/tmux.php', 'run', $path]);
    $sessions = screenSessions($data);
    preg_match_all('/^\s*([1-9][0-9]*\.' . preg_quote($name, '/') . ')\s/m', $sessions, $matches);
    if (count($matches[1]) !== 1) {
        throw new RuntimeException('Screen launch identity is ambiguous; reconcile before retrying.');
    }
    $identity = ['session' => $matches[1][0], 'pane' => '0', 'role' => $role, 'config' => $config, 'socket_dir' => $data['socket_dir'] ?? null];
    screenCommand($identity, ['-Q', 'number']);
    return $identity;
}

try {
    $path = realpath($argv[2] ?? '');
    if ($path === false) {
        throw new RuntimeException('Usage: php screen.php launch|inspect|capture|interrupt|close input.json');
    }
    $input = readInput($path);
    $mode = $argv[1] ?? '';
    $result = match ($mode) {
        'launch' => launchScreen($input, $path),
        'inspect' => ['window' => screenCommand($input, ['-Q', 'windows'])],
        'capture' => ['output' => screenCommand($input, ['-X', 'hardcopy', '-h', field($input, 'output')])],
        'interrupt' => ['output' => screenCommand($input, ['-X', 'stuff', "\x03"])],
        'close' => ['output' => screenCommand($input, ['-X', 'quit'])],
        default => throw new RuntimeException('Unknown Screen action.'),
    };
    echo json_encode(['ok' => true, 'result' => $result], JSON_THROW_ON_ERROR) . "\n";
} catch (Throwable $error) {
    echo json_encode(['ok' => false, 'event' => 'blocked', 'error' => $error->getMessage()], JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
    exit(1);
}
