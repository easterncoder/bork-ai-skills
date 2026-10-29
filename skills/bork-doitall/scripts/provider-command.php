<?php

declare(strict_types=1);

/** Classify provider mode while respecting option operands and prompt boundaries. */
function providerCommandMode(array $argv): array
{
    $codex = in_array(strtolower(basename($argv[0])), ['codex', 'codex.exe'], true);
    $valueOptions = ['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env',
        '-i', '--image', '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox',
        '-C', '--cd', '--add-dir', '-a', '--ask-for-approval'];
    $claudeValueOptions = ['--model', '--agent', '--agents', '--append-system-prompt', '--autocompact',
        '--debug-file', '--effort', '--environment', '--fallback-model', '--input-format', '--json-schema',
        '--max-budget-usd', '-n', '--name', '--output-format', '--permission-mode', '--permission-prompts',
        '--plugin-dir', '--plugin-url', '--remote-control-session-name-prefix', '--session-id', '--setting-sources',
        '--settings', '--system-prompt', '--system-prompt-snapshot'];
    $noDaemon = false;
    $hasPositional = false;
    for ($i = 1, $count = count($argv); $i < $count; $i++) {
        $arg = $argv[$i];
        if ($arg === '--') {
            break;
        }
        if ($arg === '--no-daemon') {
            $noDaemon = true;
        }
        if ($arg === '--print' || (!$codex && $arg === '-p')) {
            return ['interactive' => false, 'no_daemon' => $noDaemon];
        }
        if (in_array($arg, $codex ? $valueOptions : $claudeValueOptions, true)) {
            $i++;
            continue;
        }
        if (str_starts_with($arg, '-')) {
            continue;
        }
        if (!$hasPositional && in_array($arg, ['exec', 'e', 'review', 'app-server', 'exec-server'], true)) {
            return ['interactive' => false, 'no_daemon' => $noDaemon];
        }
        $hasPositional = true;
    }
    return ['interactive' => true, 'no_daemon' => $noDaemon];
}
