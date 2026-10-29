<?php

declare(strict_types=1);

require_once __DIR__ . '/provider-command.php';

/** Limit recovered process data to the terminal drivers' documented caller identity. */
function terminalContextKeys(): array
{
    return ['HC_TERMINAL_ID', 'HC_SESSION', 'HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_SOCKET_PATH', 'TMUX', 'TMUX_PANE', 'STY', 'WINDOW', 'SCREENDIR'];
}

/** Read one same-user interactive Codex frontend without retaining other variables. */
function terminalFrontend(string $directory, string $cwd, int $owner): ?array
{
    if (@fileowner($directory) !== $owner || @realpath($directory . '/cwd') !== $cwd
        || basename((string) @realpath($directory . '/exe')) !== 'codex') {
        return null;
    }
    $command = @file_get_contents($directory . '/cmdline');
    $stat = @file_get_contents($directory . '/stat');
    if ($command === false || $stat === false) {
        throw new RuntimeException('Cannot read the matching Codex frontend identity; procfs access may be sandbox denied. Run Codex with --no-daemon in the invoking pane.');
    }
    $args = explode("\0", rtrim($command, "\0"));
    /* Daemons and noninteractive workers cannot identify an invoking terminal. */
    if (!providerCommandMode($args)['interactive']) {
        return null;
    }
    $fields = preg_split('/\s+/', substr($stat, (int) strrpos($stat, ')') + 2));
    if (!isset($fields[19]) || !ctype_digit($fields[19])) {
        return null;
    }
    $raw = @file_get_contents($directory . '/environ');
    if ($raw === false) {
        throw new RuntimeException('Cannot inspect the matching Codex frontend environment; retry outside the sandbox.');
    }
    $environment = [];
    foreach (explode("\0", $raw) as $entry) {
        $pair = explode('=', $entry, 2);
        if (count($pair) === 2 && in_array($pair[0], terminalContextKeys(), true)) {
            $environment[$pair[0]] = $pair[1];
        }
    }
    return ['pid' => (int) basename($directory), 'start_time' => $fields[19], 'environment' => $environment];
}

/** Resolve a terminal caller only when the local frontend is unique. */
function recoverTerminalFrontend(string $root, string $cwd, int $owner, ?string $expected): ?array
{
    $candidates = [];
    foreach (glob($root . '/[0-9]*', GLOB_ONLYDIR) ?: [] as $directory) {
        $candidate = terminalFrontend($directory, $cwd, $owner);
        if ($candidate !== null) {
            $candidates[] = $candidate;
        }
    }
    $hasContext = array_filter($candidates, static fn (array $candidate) => $candidate['environment'] !== []);
    if ($expected === null && $hasContext === []) {
        return null;
    }
    $environment = $candidates[0]['environment'] ?? [];
    $reported = $expected === null ? $environment !== [] : ($expected === 'herdr' ? ($environment['HERDR_ENV'] ?? null) === '1' : !empty($environment[match ($expected) { 'hc' => 'HC_TERMINAL_ID', 'screen' => 'STY', default => 'TMUX' }]));
    if (count($candidates) !== 1 || !$reported) {
        $reason = count($candidates) > 1 ? 'ambiguous matching frontends' : (count($candidates) === 0
            ? 'missing frontend in this working directory or inaccessible procfs' : 'frontend lacks the reported terminal context');
        throw new RuntimeException('Cannot uniquely resolve the reported ' . ($expected ?? 'terminal') . ' caller: ' . $reason . '. Retry outside the sandbox or run Codex with --no-daemon in the invoking pane.');
    }
    return $candidates[0];
}

/** Identify a shared Codex backend in the visible invoking process ancestry. */
function terminalSharedBackend(string $root, int $pid): bool
{
    $seen = [];
    while ($pid > 0 && !isset($seen[$pid])) {
        $seen[$pid] = true;
        $directory = $root . '/' . $pid;
        $raw = @file_get_contents($directory . '/cmdline');
        $stat = @file_get_contents($directory . '/stat');
        if ($raw === false || $stat === false) {
            return false;
        }
        $args = explode("\0", rtrim($raw, "\0"));
        $mode = providerCommandMode($args);
        if (basename((string) @realpath($directory . '/exe')) === 'codex'
            && !$mode['interactive'] && !$mode['no_daemon']) {
            return true;
        }
        $fields = preg_split('/\s+/', substr($stat, (int) strrpos($stat, ')') + 2));
        $pid = (int) ($fields[1] ?? 0);
    }
    return false;
}

/** Bind discovery and later terminal commands to the same verified caller context. */
function environmentRuntime(?string $expected): array
{
    $run = 'environmentCommand';
    $runtime = ['env' => 'getenv', 'run' => $run, 'ancestor' => static fn (int $pid) => environmentAncestor($pid, $run), 'frontend' => null];
    $signals = array_filter(array_map('getenv', array_diff(terminalContextKeys(), ['SCREENDIR', 'HC_SESSION'])), static fn ($value) => $value !== false && $value !== '');
    if (!in_array($expected, [null, 'hc', 'herdr', 'tmux', 'screen'], true)
        || ($signals === [] && $expected === null && !getenv('CODEX_THREAD_ID'))) {
        return $runtime;
    }
    $directError = null;
    if ($signals !== []) {
        try {
            detectEnvironment($runtime['env'], $run, $runtime['ancestor'], $expected);
            if (!getenv('CODEX_THREAD_ID') || !terminalSharedBackend('/proc', getmypid())) {
                return $runtime;
            }
        } catch (Throwable $error) {
            $directError = $error->getMessage();
            if (!getenv('CODEX_THREAD_ID')) {
                throw new RuntimeException('Stale or inaccessible inherited caller context: ' . $directError . ' Run discovery in the invoking pane, or restart Codex with --no-daemon; never copy unrelated pane variables.', 0, $error);
            }
        }
    }
    if (!is_dir('/proc/self')) {
        if ($expected === null) {
            return $runtime;
        }
        throw new RuntimeException('Detached terminal caller recovery needs local procfs; run discovery in the invoking terminal.');
    }
    $cwd = realpath(getcwd());
    $owner = fileowner('/proc/self');
    try {
        $frontend = recoverTerminalFrontend('/proc', $cwd, $owner, $expected);
    } catch (Throwable $error) {
        throw new RuntimeException(($directError === null ? 'Missing or detached caller context. ' : 'Stale or inaccessible inherited caller context: ' . $directError . ' ') . $error->getMessage(), 0, $error);
    }
    if ($frontend === null) {
        return $runtime;
    }
    /* Discard stale membership for other drivers before restoring the caller. */
    $environment = array_replace(array_diff_key(getenv(), array_flip(terminalContextKeys())), $frontend['environment']);
    $run = static function (array $args) use ($frontend, $cwd, $owner, $environment, $expected): string {
        $current = recoverTerminalFrontend('/proc', $cwd, $owner, $expected);
        if ($current !== $frontend) {
            throw new RuntimeException('Terminal frontend identity changed; reconcile before retrying.');
        }
        return environmentCommand($args, $environment);
    };
    return [
        'env' => static fn (string $key) => $environment[$key] ?? false,
        'run' => $run,
        'ancestor' => static fn (int $pid) => environmentAncestor($pid, $run, $frontend['pid']),
        'frontend' => ['pid' => $frontend['pid'], 'start_time' => $frontend['start_time'], 'cwd' => $cwd, 'source' => 'same-user-cwd'],
    ];
}
