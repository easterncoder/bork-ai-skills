<?php

declare(strict_types=1);

require_once __DIR__ . '/layout.php';

/** Submit one runner into a previously verified stable Herdr placement. */
function borkHerdrLaunch(array $input, string $path): array
{
    $cwd = field($input, 'cwd');
    if (!is_dir($cwd)) {
        throw new RuntimeException('Working directory missing.');
    }
    validateJob(readInput(field($input, 'job')));
    $runner = runnerCommand($path, field($input, 'shell'));
    $layout = readInput(field($input, 'layout_record'));
    if ($layout['driver'] !== 'herdr') {
        throw new RuntimeException('Herdr launch requires a verified Herdr layout.');
    }
    borkLayoutVerify($layout);
    $key = field($input, 'role') . ':' . ($input['slot'] ?? '');
    $pane = $layout['resources'][$key]['id'] ?? '';
    $process = borkLayoutHerdr($layout['context'], ['pane', 'process-info', '--pane', $pane]);
    $process = $process['process_info'] ?? $process;
    $foreground = $process['foreground_processes'] ?? [];
    if (($process['pane_id'] ?? null) !== $pane || !is_int($process['shell_pid'] ?? null)
        || count($foreground) !== 1 || ($foreground[0]['pid'] ?? null) !== $process['shell_pid']) {
        throw new RuntimeException('Herdr placement is not a verified available foreground shell.');
    }
    $placement = borkLayoutAction('claim', [
        'record' => $input['layout_record'], 'role' => field($input, 'role'), 'slot' => $input['slot'] ?? null,
        'task_id' => field($input, 'task_id'), 'target_id' => field($input, 'target_id'),
    ]);
    /* The claim remains held on an uncertain submission, preventing replay. */
    $reply = borkLayoutHerdr($layout['context'], ['pane', 'run', $placement['id'], $runner]);
    return ['pane' => $placement['id'], 'role' => $input['role'], 'slot' => $input['slot'],
        'layout_record' => $input['layout_record'], 'submission' => $reply];
}

try {
    $path = realpath($argv[2] ?? '');
    if (($argv[1] ?? '') !== 'launch' || $path === false) {
        throw new RuntimeException('Usage: php herdr.php launch input.json');
    }
    echo json_encode(['ok' => true, 'result' => borkHerdrLaunch(readInput($path), $path)], JSON_THROW_ON_ERROR) . "\n";
} catch (Throwable $error) {
    echo json_encode(['ok' => false, 'event' => 'blocked', 'error' => $error->getMessage()], JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
    exit(1);
}
