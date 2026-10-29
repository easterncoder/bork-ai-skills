<?php

declare(strict_types=1);

require_once __DIR__ . '/terminal.php';
require_once __DIR__ . '/provider-command.php';
require_once __DIR__ . '/layout.php';

/** Decode the documented direct hc JSON response, rejecting error envelopes. */
function hcReply(array $args, callable $run): array
{
    $reply = json_decode($run(array_merge(['hc'], $args)), true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($reply) || isset($reply['error'])) {
        throw new RuntimeException('hc command failed; reconcile the recorded terminal before retrying.');
    }
    return $reply;
}

/** Require a local persistent terminal identity and its process provenance. */
function validateHcIdentity(array $identity): void
{
    if (!preg_match('/^t[0-9a-z]+$/D', $identity['terminal_id'] ?? '')
        || !is_string($identity['core_id'] ?? null) || $identity['core_id'] === ''
        || !is_int($identity['pid'] ?? null) || $identity['pid'] < 1
        || !is_int($identity['created_ms'] ?? null)) {
        throw new RuntimeException('hc terminal identity evidence is incomplete.');
    }
}

/** Verify the installed manual and required command flags without creating terminals. */
function hcCapabilities(callable $run): array
{
    $manual = $run(['hc', '--skill']);
    if (!str_contains($manual, '--no-daemon') || !str_contains($manual, 'first_message.sent')) {
        throw new RuntimeException('Installed hc manual lacks the required agent delivery contract.');
    }
    foreach (['run' => '--bg', 'send' => '--if', 'wait' => '--timeout', 'get' => 'TERMINAL',
        'read' => '--lines', 'interrupt' => 'TERMINAL', 'kill' => 'TERMINAL', 'rm' => 'TERMINAL'] as $command => $flag) {
        if (!str_contains($run(['hc', $command, '--help']), $flag)) {
            throw new RuntimeException('Missing hc capability: ' . $command);
        }
    }
    return ['version' => $run(['hc', '--version']), 'manual_sha256' => hash('sha256', $manual)];
}

/** Verify inherited caller membership without treating installation as membership. */
function detectHcContext(callable $env, callable $run, callable $ancestor): array
{
    $id = $env('HC_TERMINAL_ID');
    if ($id === false || $id === '') {
        return ['active' => false];
    }
    if (!is_string($id) || !preg_match('/^t[0-9a-z]+$/D', $id)) {
        throw new RuntimeException('Invalid explicit hc caller terminal.');
    }
    $terminal = hcReply(['get', $id], $run);
    $server = hcReply(['server', 'status'], $run);
    $identity = ['active' => true, 'terminal_id' => $id, 'core_id' => $server['core']['id'] ?? null,
        'pid' => $terminal['pid'] ?? null, 'created_ms' => $terminal['created_ms'] ?? null,
        'session' => $env('HC_SESSION') ?: null];
    validateHcIdentity($identity);
    if (($terminal['address'] ?? null) !== $id || ($terminal['state'] ?? null) !== 'live' || !$ancestor($identity['pid'])) {
        throw new RuntimeException('Explicit hc caller is stale or not an ancestor of this process.');
    }
    return $identity + ['capabilities' => hcCapabilities($run)];
}

/** Atomically retain lifecycle intent and replies outside disposable worktrees. */
function hcRecord(string $path, array $data): void
{
    if (is_link($path) || !is_dir(dirname($path))) {
        throw new RuntimeException('hc record needs an existing durable directory and regular file.');
    }
    $temp = tempnam(dirname($path), '.hc-');
    if ($temp === false || file_put_contents($temp, json_encode($data, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT)) === false || !rename($temp, $path)) {
        throw new RuntimeException('Cannot persist hc lifecycle evidence.');
    }
}

/** Bind every operation to the original core and the exact owned terminal. */
function hcOwned(array $record, callable $run): array
{
    $server = hcReply(['server', 'status'], $run);
    if (($server['core']['id'] ?? null) !== field($record, 'core_id')) {
        throw new RuntimeException('hc core changed; reconcile before continuing.');
    }
    $terminal = hcReply(['get', field($record, 'terminal_id')], $run);
    if (($terminal['address'] ?? null) !== $record['terminal_id'] || ($terminal['created_ms'] ?? null) !== ($record['created_ms'] ?? null)
        || ($terminal['labels']['bork-run'] ?? null) !== field($record, 'run_id')
        || ($terminal['name'] ?? null) !== field($record, 'name')) {
        throw new RuntimeException('hc terminal ownership changed; preserve it.');
    }
    return $terminal;
}

/** Classify lifecycle evidence without interpreting idle status as task success. */
function hcObservation(array $terminal): string
{
    if (($terminal['status']['state'] ?? null) === 'blocked') {
        return 'attention';
    }
    if (($terminal['state'] ?? null) === 'finished') {
        return 'stopped_requires_result';
    }
    return 'requires_result_and_ack';
}

/** Bind or restore the stable visible slot while preserving the user's final focus. */
function hcLayoutShow(array $record, bool $show = true): void
{
    if (!isset($record['layout_record'], $record['placement'])) {
        return;
    }
    borkLayoutAction('bind', ['record' => $record['layout_record'], 'placement' => $record['role'] . ':' . $record['slot'],
        'task_id' => $record['task_id'], 'run_id' => $record['run_id'], 'terminal_id' => $record['terminal_id'], 'created_ms' => $record['created_ms'], 'show' => $show]);
}

/** Launch interactive roles and retain uncertain operations for explicit reconciliation. */
function hcAction(string $action, array $input, callable $run): array
{
    $path = field($input, 'record');
    if ($action === 'launch') {
        if (file_exists($path) || is_link($path)) {
            throw new RuntimeException('Launch record exists; reconcile instead of launching twice.');
        }
        $job = readInput(field($input, 'job'));
        validateJob($job);
        $argv = $job['argv'];
        $mode = validateProviderCommand($argv);
        if (!$mode['interactive']) {
            throw new RuntimeException('hc roles require an interactive provider command.');
        }
        hcCapabilities($run);
        if (!in_array($input['role'] ?? '', ['master', 'review', 'fix'], true)
            || !preg_match('/^[a-z0-9_-]{1,32}$/D', field($input, 'name'))
            || !is_dir(field($input, 'cwd'))) {
            throw new RuntimeException('Invalid hc role, name or working directory.');
        }
        $server = hcReply(['server', 'status'], $run);
        $record = array_replace($input, ['core_id' => $server['core']['id'] ?? null, 'state' => 'launch_uncertain']);
        field($record, 'core_id');
        field($record, 'run_id');
        field($record, 'task_id');
        if (isset($input['layout_record'])) {
            $layout = readInput(field($input, 'layout_record'));
            if ($layout['driver'] !== 'hc' || ($layout['context']['session'] ?? null) !== ($input['session'] ?? null)
                || $layout['context']['core_id'] !== $record['core_id']) {
                throw new RuntimeException('App layout and worker must use the same recorded core/session.');
            }
            $record['placement'] = borkLayoutAction('claim', array_replace($input, ['record' => $input['layout_record']]));
        }
        hcRecord($path, $record);
        /* The CLI task is in argv at launch, never sent to a booting agent. */
        $labels = ['--label', 'bork-run=' . $record['run_id']];
        if (isset($record['layout_record'])) {
            array_push($labels, '--label', 'bork-task=' . $record['task_id']);
        }
        $reply = hcReply(array_merge(['run', '--json', '--bg', '--name', $input['name'], '--cwd', $input['cwd']], $labels, $argv), $run);
        $record['terminal_id'] = $reply['address'] ?? null;
        $record['launch_reply'] = $reply;
        $record['state'] = ($reply['first_message']['sent'] ?? false) ? 'awaiting_result' : 'delivery_requires_reconciliation';
        hcRecord($path, $record);
        $terminal = hcReply(['get', field($record, 'terminal_id')], $run);
        $record['created_ms'] = $terminal['created_ms'] ?? null;
        hcRecord($path, $record);
        hcOwned($record, $run);
        hcLayoutShow($record);
        return $record;
    }
    $record = readInput($path);
    if ($action === 'reconcile') {
        $server = hcReply(['server', 'status'], $run);
        if (($server['core']['id'] ?? null) !== field($record, 'core_id')) {
            throw new RuntimeException('hc core changed during launch reconciliation.');
        }
        $matches = [];
        foreach (hcReply(['ls', '--all'], $run)['terminals'] ?? [] as $candidate) {
            if (($candidate['name'] ?? null) === field($record, 'name')) {
                $matches[] = hcReply(['get', field($candidate, 'address')], $run);
            }
        }
        if (count($matches) !== 1 || ($matches[0]['labels']['bork-run'] ?? null) !== field($record, 'run_id')) {
            throw new RuntimeException('Uncertain launch is not uniquely attributable; preserve evidence and do not retry.');
        }
        if ((isset($record['terminal_id']) && $record['terminal_id'] !== $matches[0]['address'])
            || (isset($record['created_ms']) && $record['created_ms'] !== $matches[0]['created_ms'])) {
            throw new RuntimeException('Recorded hc terminal was replaced; preserve the new occupant.');
        }
        $record['terminal_id'] = $matches[0]['address'];
        $record['created_ms'] = $matches[0]['created_ms'];
        hcRecord($path, $record);
        hcOwned($record, $run);
        hcLayoutShow($record);
        return $record;
    }
    $terminal = hcOwned($record, $run);
    if ($action === 'acknowledge') {
        $ack = readInput(field($input, 'acknowledgment'));
        foreach (['run_id', 'terminal_id', 'task_id'] as $key) {
            if (field($ack, $key) !== field($record, $key)) {
                throw new RuntimeException('Task acknowledgment identity mismatch.');
            }
        }
        $record['acknowledgment'] = $input['acknowledgment'];
        $record['state'] = 'acknowledged_requires_result';
        hcRecord($path, $record);
        return $record;
    }
    if ($action === 'inspect') {
        $attention = hcObservation($terminal) === 'attention' ? $run(['hc', 'read', $record['terminal_id'], '--lines', '120']) : null;
        $session = $record['session'] ?? null;
        return ['prompt_output' => $attention, 'terminal' => $terminal, 'observation' => hcObservation($terminal),
            'navigation' => $session === null ? 'hc attach ' . $record['terminal_id'] : null,
            'navigation_environment' => $session === null ? [] : ['HC_SESSION' => $session],
            'navigation_argv' => ['hc', 'attach', $record['terminal_id']]];
    }
    if ($action === 'wait') {
        return hcReply(['wait', $record['terminal_id'], '--timeout', '30'], $run);
    }
    if ($action === 'send') {
        if (($terminal['state'] ?? null) !== 'live' || !in_array($terminal['status']['state'] ?? null, ['idle', 'done'], true)
            || ($record['state'] ?? null) === 'send_uncertain') {
            throw new RuntimeException('Read and reconcile readiness or uncertain delivery before sending; never force a prompt.');
        }
        $record['state'] = 'send_uncertain';
        $record['pending_task'] = field($input, 'task');
        $record['task_id'] = field($input, 'task_id');
        hcRecord($path, $record);
        $args = ($terminal['status']['state'] ?? null) === 'idle' ? ['send', '--if', 'idle'] : ['send'];
        $reply = hcReply(array_merge($args, [$record['terminal_id'], $input['task']]), $run);
        $record['send_reply'] = $reply;
        /* A successful send still needs a matching task acknowledgment. */
        hcRecord($path, $record);
        return $reply;
    }
    if ($action === 'interrupt') {
        return hcReply(['interrupt', $record['terminal_id']], $run);
    }
    if ($action === 'cleanup') {
        /* The owner accepts results and stops native descendants before this call. */
        if (($input['results_verified'] ?? false) !== true || ($input['descendants_stopped'] ?? false) !== true) {
            throw new RuntimeException('Verified result and stopped-descendant evidence are required.');
        }
        $record['final_terminal'] = $terminal;
        $record['output'] = $run(['hc', 'read', $record['terminal_id'], '--lines', '120']);
        $record['state'] = 'cleanup_pending';
        hcRecord($path, $record);
        if (($terminal['state'] ?? null) !== 'finished') {
            hcReply(['kill', $record['terminal_id']], $run);
        }
        $terminal = hcOwned($record, $run);
        if (($terminal['state'] ?? null) !== 'finished') {
            throw new RuntimeException('hc process has not stopped.');
        }
        $record['exit_terminal'] = $terminal;
        hcLayoutShow($record, false);
        $record['remove_reply'] = hcReply(['rm', $record['terminal_id']], $run);
        if (($record['remove_reply']['removed'] ?? null) !== $record['terminal_id']) {
            throw new RuntimeException('hc removal response does not match the owned terminal.');
        }
        $record['state'] = 'removed';
        hcRecord($path, $record);
        return $record;
    }
    throw new RuntimeException('Unknown hc action.');
}

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    try {
        $action = $argv[1] ?? '';
        $input = readInput($argv[2] ?? '');
        $source = $action === 'launch' ? $input : readInput(field($input, 'record'));
        $session = array_key_exists('session', $source) ? $source['session'] : (getenv('HC_SESSION') ?: null);
        if ($session !== null && (!is_string($session) || $session === '' || preg_match('/[\x00\r\n]/', $session))) {
            throw new RuntimeException('Invalid hc session routing identity.');
        }
        $environment = getenv();
        unset($environment['HC_SESSION']);
        if ($session !== null) {
            $environment['HC_SESSION'] = $session;
        }
        $input['session'] = $session;
        $run = static fn (array $args): string => execute($args, [0], $environment);
        $result = hcAction($action, $input, $run);
        echo json_encode(['ok' => true, 'result' => $result], JSON_THROW_ON_ERROR) . "\n";
    } catch (Throwable $error) {
        echo json_encode(['ok' => false, 'event' => 'blocked', 'error' => $error->getMessage()], JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
        exit(1);
    }
}
