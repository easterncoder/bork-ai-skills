<?php

declare(strict_types=1);

require_once __DIR__ . '/terminal-context.php';

/** Run a local command with a bounded observation period and explicit environment. */
function environmentCommand(array $args, ?array $environment = null): string
{
    $process = proc_open($args, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $environment, ['bypass_shell' => true]);
    if (!is_resource($process)) {
        throw new RuntimeException('Session discovery command could not start: ' . $args[0]);
    }
    fclose($pipes[0]);
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);
    $output = '';
    $deadline = microtime(true) + 5;
    do {
        $output .= stream_get_contents($pipes[1]);
        stream_get_contents($pipes[2]);
        $status = proc_get_status($process);
        if (!$status['running']) {
            break;
        }
        if (microtime(true) >= $deadline) {
            proc_terminate($process, 9);
            fclose($pipes[1]);
            fclose($pipes[2]);
            proc_close($process);
            throw new RuntimeException('Session discovery timed out; reconcile explicit context.');
        }
        usleep(10000);
    } while (true);
    $output .= stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    proc_close($process);
    if ($status['exitcode'] !== 0) {
        throw new RuntimeException('Session discovery failed for ' . $args[0] . '; verify the inherited context and local command access (ps is required for ancestry verification).');
    }
    return trim($output);
}

/** Verify that a live pane shell is an ancestor of this invoking process. */
function environmentAncestor(int $shell, callable $run, ?int $caller = null): bool
{
    $parents = [];
    foreach (explode("\n", $run(['ps', '-eo', 'pid=,ppid='])) as $line) {
        if (preg_match('/^\s*(\d+)\s+(\d+)\s*$/', $line, $match)) {
            $parents[(int) $match[1]] = (int) $match[2];
        }
    }
    $pid = $caller ?? getmypid();
    $seen = [];
    while ($pid > 0 && !isset($seen[$pid])) {
        if ($pid === $shell) {
            return true;
        }
        $seen[$pid] = true;
        $pid = $parents[$pid] ?? 0;
    }
    return false;
}

/** Decode only a successful Herdr response from the inherited local session. */
function environmentHerdr(array $args, callable $run): array
{
    $reply = json_decode($run(array_merge(['herdr'], $args)), true, 512, JSON_THROW_ON_ERROR);
    if (isset($reply['error']) || !is_array($reply['result'] ?? null)) {
        throw new RuntimeException('Herdr session response is not verifiable.');
    }
    return $reply['result'];
}

/** Detect membership independently of workflow capacity or installed executables. */
function detectEnvironment(callable $env, callable $run, callable $ancestor, ?string $expectedEnvironment = null): array
{
    if ($expectedEnvironment !== null && !in_array($expectedEnvironment, ['herdr', 'tmux'], true)) {
        throw new RuntimeException('Unknown expected terminal environment.');
    }
    $contexts = ['herdr' => ['active' => false], 'tmux' => ['active' => false]];
    $herdrKeys = ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_SOCKET_PATH'];
    $herdr = array_combine($herdrKeys, array_map($env, $herdrKeys));
    if (count(array_filter($herdr, static fn ($value) => $value !== false && $value !== '')) > 0) {
        if ($herdr['HERDR_ENV'] !== '1' || !$herdr['HERDR_PANE_ID'] || !$herdr['HERDR_SOCKET_PATH'] || !$herdr['HERDR_TAB_ID'] || !$herdr['HERDR_WORKSPACE_ID']) {
            throw new RuntimeException('Explicit Herdr context is incomplete; restore the managed pane environment.');
        }
        /* The inherited caller ID remains an alias when a pane moves. */
        $pane = environmentHerdr(['pane', 'current', '--current'], $run)['pane'] ?? null;
        $process = environmentHerdr(['pane', 'process-info', '--current'], $run)['process_info'] ?? null;
        if (!is_array($pane) || !is_array($process) || !is_string($pane['pane_id'] ?? null) || $pane['pane_id'] === ''
            || !is_string($pane['tab_id'] ?? null) || $pane['tab_id'] === ''
            || !is_string($pane['workspace_id'] ?? null) || $pane['workspace_id'] === ''
            || ($process['pane_id'] ?? null) !== $pane['pane_id'] || !is_int($process['shell_pid'] ?? null)
            || !$ancestor($process['shell_pid'])) {
            throw new RuntimeException('Explicit Herdr pane is stale or not an ancestor of this process; reconcile membership.');
        }
        $contexts['herdr'] = ['active' => true, 'pane_id' => $pane['pane_id'], 'tab_id' => $pane['tab_id'], 'workspace_id' => $pane['workspace_id'], 'socket' => $herdr['HERDR_SOCKET_PATH'], 'shell_pid' => $process['shell_pid']];
    }
    $tmux = $env('TMUX');
    $pane = $env('TMUX_PANE');
    if (($tmux !== false && $tmux !== '') || ($pane !== false && $pane !== '')) {
        if (!is_string($tmux) || !preg_match('/^(.*),(\d+),(\d+)$/D', $tmux, $match) || $match[1] === ''
            || !is_string($pane) || !preg_match('/^%\d+$/D', $pane)) {
            throw new RuntimeException('Explicit tmux context is incomplete; restore TMUX and TMUX_PANE in the live pane.');
        }
        $socket = $match[1];
        $format = '#{pane_id}|#{pane_pid}|#{socket_path}|#{pid}|#{session_id}';
        $reply = explode('|', $run(['tmux', '-S', $socket, 'display-message', '-p', '-t', $pane, $format]));
        if (count($reply) !== 5 || $reply[0] !== $pane || !ctype_digit($reply[1]) || $reply[2] !== $socket
            || $reply[3] !== $match[2] || $reply[4] !== '$' . $match[3] || !$ancestor((int) $reply[1])) {
            throw new RuntimeException('Explicit tmux context is stale or belongs to another process; reconcile the live socket and pane.');
        }
        $contexts['tmux'] = ['active' => true, 'pane_id' => $pane, 'socket' => $socket, 'shell_pid' => (int) $reply[1], 'session_id' => $reply[4]];
    }
    if ($expectedEnvironment !== null && !$contexts[$expectedEnvironment]['active']) {
        throw new RuntimeException('Reported ' . $expectedEnvironment . ' membership is not visible to this tool process; verify discovery in the invoking terminal. A sandbox, environment filter or detached tool backend may hide caller context. Do not select another driver or copy context from an unrelated process.');
    }
    return $contexts;
}

/** Choose by verified membership, then require the selected driver's capacity. */
function selectEnvironment(array $contexts, array $capabilities): array
{
    foreach (['herdr', 'tmux'] as $driver) {
        if (!is_bool($contexts[$driver]['active'] ?? null)) {
            throw new RuntimeException('Missing verified membership: ' . $driver);
        }
    }
    $selected = $contexts['herdr']['active'] ? 'herdr' : ($contexts['tmux']['active'] ? 'tmux' : 'native');
    $capability = $capabilities[$selected] ?? null;
    if (!is_array($capability) || ($capability['supported'] ?? null) !== true || !is_string($capability['evidence'] ?? null)
        || trim($capability['evidence']) === '') {
        $reason = is_array($capability) && is_string($capability['blocker'] ?? null) ? $capability['blocker'] : 'verified workflow capacity evidence is missing';
        throw new RuntimeException('Selected driver ' . $selected . ' is blocked: ' . $reason . '. No fallback is permitted.');
    }
    return ['version' => 1, 'execution_driver' => $selected, 'contexts' => $contexts, 'capability' => $capability];
}

/** Validate additive selection evidence without reinterpreting legacy approvals. */
function validateEnvironmentSelection(array $plan): void
{
    if (isset($plan['execution_driver']) && !in_array($plan['execution_driver'], ['native', 'tmux', 'herdr'], true)) {
        throw new RuntimeException('Unknown recorded execution driver.');
    }
    if (!array_key_exists('environment_selection', $plan)) {
        return;
    }
    $selection = $plan['environment_selection'];
    if (!is_array($selection) || ($selection['version'] ?? null) !== 1) {
        throw new RuntimeException('Unsupported environment selection evidence.');
    }
    foreach (['herdr', 'tmux'] as $driver) {
        $context = $selection['contexts'][$driver] ?? [];
        if (($context['active'] ?? false) === true && (!is_string($context['pane_id'] ?? null) || $context['pane_id'] === ''
            || !is_string($context['socket'] ?? null) || $context['socket'] === '' || !is_int($context['shell_pid'] ?? null) || $context['shell_pid'] < 1)) {
            throw new RuntimeException('Active session identity evidence is missing: ' . $driver);
        }
    }
    $selected = $selection['execution_driver'] ?? '';
    $checked = selectEnvironment($selection['contexts'] ?? [], [$selected => $selection['capability'] ?? null]);
    if (($plan['execution_driver'] ?? null) !== $checked['execution_driver'] || $selected !== $checked['execution_driver']) {
        throw new RuntimeException('Recorded driver differs from approved environment selection.');
    }
}

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    try {
        $terminalCommand = in_array($argv[1] ?? '', ['herdr', 'tmux'], true) ? $argv[1] : null;
        $input = $terminalCommand !== null ? ['expected_environment' => $terminalCommand] : json_decode(file_get_contents($argv[1] ?? 'php://stdin'), true, 512, JSON_THROW_ON_ERROR);
        $runtime = environmentRuntime($input['expected_environment'] ?? null);
        $contexts = detectEnvironment($runtime['env'], $runtime['run'], $runtime['ancestor'], $input['expected_environment'] ?? null);
        if ($runtime['frontend'] !== null) {
            foreach (['herdr', 'tmux'] as $driver) {
                if ($contexts[$driver]['active']) {
                    $contexts[$driver]['frontend'] = $runtime['frontend'];
                }
            }
        }
        if ($terminalCommand !== null) {
            $args = array_slice($argv, 2);
            if ($args === [] || str_starts_with($args[0], '-')) {
                throw new RuntimeException('Supply a local terminal command group; socket, session and remote overrides are not supported.');
            }
            $prefix = $terminalCommand === 'tmux' ? ['tmux', '-S', $contexts['tmux']['socket']] : ['herdr'];
            echo ($runtime['run'])(array_merge($prefix, $args)) . "\n";
            exit(0);
        }
        $result = selectEnvironment($contexts, $input['capabilities'] ?? []);
        echo json_encode(['ok' => true, 'result' => $result], JSON_THROW_ON_ERROR) . "\n";
    } catch (Throwable $error) {
        echo json_encode(['ok' => false, 'event' => 'blocked', 'error' => $error->getMessage()], JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
        exit(1);
    }
}
