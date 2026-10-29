<?php

declare(strict_types=1);

require_once __DIR__ . '/evidence.php';
require_once __DIR__ . '/automation.php';

/* Portable CLI mechanics. Input and output are one JSON object per invocation. */

/** Run a command without shell interpolation and capture its result. */
function command(array $args, ?string $cwd = null): array
{
    $errors = fopen('php://temp', 'w+');
    $process = proc_open($args, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => $errors], $pipes, $cwd);
    if (!is_resource($process)) {
        fclose($errors);
        throw new RuntimeException('Unable to start command.');
    }
    fclose($pipes[0]);
    $output = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    $exit = proc_close($process);
    fclose($errors);
    return ['code' => $exit, 'output' => rtrim($output, "\r\n")];
}

/** Return successful Git output without echoing command arguments or credentials. */
function git(string $repo, array $args): string
{
    $result = command(array_merge(['git', '-C', $repo], $args));
    if ($result['code'] !== 0) {
        throw new RuntimeException('Git operation failed; inspect locally before retrying.');
    }
    return $result['output'];
}

/** Require a nonempty string parameter. */
function value(array $input, string $key): string
{
    if (!isset($input[$key]) || !is_string($input[$key]) || $input[$key] === '') {
        throw new RuntimeException('Missing string field: ' . $key);
    }
    return $input[$key];
}

/** Read a JSON object from a regular file. */
function readJson(string $path): array
{
    if (is_link($path) || !is_file($path)) {
        throw new RuntimeException('Expected regular JSON file.');
    }
    $data = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($data)) {
        throw new RuntimeException('Expected JSON object.');
    }
    return $data;
}

/** Atomically publish content into an existing directory without following a target link. */
function atomicWrite(string $path, string $content): void
{
    if (is_link($path) || !is_dir(dirname($path))) {
        throw new RuntimeException('Unsafe target or missing destination directory.');
    }
    $temporary = tempnam(dirname($path), '.bork-');
    if ($temporary === false) {
        throw new RuntimeException('Unable to create temporary file.');
    }
    try {
        if (file_put_contents($temporary, $content) !== strlen($content) || !rename($temporary, $path)) {
            throw new RuntimeException('Atomic publication failed.');
        }
    } finally {
        if (is_file($temporary)) {
            unlink($temporary);
        }
    }
}

/** Collect local identity and a compact fingerprint for change detection. */
function inspectRepo(string $repo): array
{
    $root = git($repo, ['rev-parse', '--show-toplevel']);
    $status = git($root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored']);
    return [
        'worktree' => $root,
        'common_git_dir' => git($root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        'branch' => git($root, ['symbolic-ref', '--short', 'HEAD']),
        'head' => git($root, ['rev-parse', 'HEAD']),
        'tree' => git($root, ['rev-parse', 'HEAD^{tree}']),
        'status_hash' => hash('sha256', $status),
        'clean_including_ignored' => $status === '',
        'status_entries' => $status === '' ? [] : explode("\0", rtrim($status, "\0")),
    ];
}

/** Check the expected branch and commit immediately before a local action. */
function guard(array $input): array
{
    $state = inspectRepo(value($input, 'repo'));
    if ($state['branch'] !== value($input, 'branch') || $state['head'] !== value($input, 'head')) {
        throw new RuntimeException('Branch or HEAD changed.');
    }
    return $state;
}

/** Poll a status file for at most fifty seconds without background processes. */
function waitStatus(array $input): array
{
    $path = value($input, 'path');
    $seconds = max(0, min(50, (int) ($input['seconds'] ?? 50)));
    $wanted = $input['wanted'] ?? ['good', 'blocked'];
    $valid = ['coded', 'reviewing', 'reviewed', 'coding', 'good', 'blocked'];
    if (!is_array($wanted) || array_diff($wanted, $valid)) {
        throw new RuntimeException('Invalid wanted states.');
    }
    $deadline = microtime(true) + $seconds;
    do {
        if (is_link($path)) {
            throw new RuntimeException('Status must not be a symlink.');
        }
        $state = is_file($path) ? trim(file_get_contents($path)) : null;
        if ($state === null && !($input['allow_missing'] ?? false)) {
            throw new RuntimeException('Status missing after initialization.');
        }
        if ($state !== null && !in_array($state, $valid, true)) {
            throw new RuntimeException('Invalid status.');
        }
        if (in_array($state, array_merge($wanted, ['good', 'blocked']), true)) {
            return ['event' => $state];
        }
        $remaining = $deadline - microtime(true);
        if ($remaining <= 0) {
            return ['event' => 'waiting', 'state' => $state];
        }
        usleep((int) (min(10, $remaining) * 1000000));
    } while (true);
}

/** Compare complete, caller-normalized maps and return only changed entries. */
function delta(array $input): array
{
    $old = readJson(value($input, 'previous'));
    $new = readJson(value($input, 'current'));
    $changed = [];
    foreach ($new as $key => $entry) {
        if (!array_key_exists($key, $old) || $old[$key] !== $entry) {
            $changed[$key] = $entry;
        }
    }
    $removed = array_values(array_diff(array_keys($old), array_keys($new)));
    return ['event' => $changed || $removed ? 'changed' : 'unchanged', 'changed' => (object) $changed, 'removed' => $removed];
}

/** Publish a role-owned status transition after checking the session and Git identity. */
function transition(array $input): array
{
    $repo = value($input, 'repo');
    $state = guard($input);
    $session = readJson(value($input, 'session'));
    if (($session['run_id'] ?? null) !== value($input, 'run_id') || realpath($session['worktree'] ?? '') !== realpath($repo)) {
        throw new RuntimeException('Session identity mismatch.');
    }
    $from = value($input, 'from');
    $to = value($input, 'to');
    $role = value($input, 'role');
    $allowed = [
        'review' => ['coded:reviewing', 'coded:blocked', 'reviewing:reviewed', 'reviewing:good', 'reviewing:blocked'],
        'fix' => ['reviewed:coding', 'reviewed:blocked', 'coding:coded', 'coding:blocked'],
        'owner' => ['missing:coded', 'good:coded'],
    ];
    if (!in_array($from . ':' . $to, $allowed[$role] ?? [], true)) {
        throw new RuntimeException('Transition is not owned by this role.');
    }
    $path = $state['worktree'] . DIRECTORY_SEPARATOR . '.status';
    $mutex = $path . '.lock';
    if (!@mkdir($mutex, 0700)) {
        throw new RuntimeException('Transition lock exists; reconcile before retrying.');
    }
    try {
        if (is_link($path)) {
            throw new RuntimeException('Status must not be a symlink.');
        }
        $actual = is_file($path) ? trim(file_get_contents($path)) : 'missing';
        if ($actual !== $from) {
            throw new RuntimeException('Status changed before handoff.');
        }
        guard($input);
        atomicWrite($path, $to . "\n");
    } finally {
        rmdir($mutex);
    }
    return ['event' => $to];
}

/** Acquire or release a lock only with the recorded opaque owner token. */
function lockAction(array $input): array
{
    $path = value($input, 'path');
    $token = value($input, 'token');
    if (($input['operation'] ?? 'acquire') === 'acquire') {
        if (!@mkdir($path, 0700)) {
            throw new RuntimeException('Lock already exists or parent unavailable.');
        }
        atomicWrite($path . '/owner.json', json_encode(['token' => $token], JSON_THROW_ON_ERROR));
        return ['event' => 'acquired'];
    }
    if (($input['operation'] ?? '') !== 'release' || is_link($path)) {
        throw new RuntimeException('Invalid lock operation.');
    }
    if ((readJson($path . '/owner.json')['token'] ?? null) !== $token) {
        throw new RuntimeException('Lock owner mismatch.');
    }
    if (count(scandir($path)) !== 3) {
        throw new RuntimeException('Unexpected lock contents.');
    }
    unlink($path . '/owner.json');
    if (!rmdir($path)) {
        throw new RuntimeException('Lock removal failed.');
    }
    return ['event' => 'released'];
}

/** Verify only the specified new commit range, including author and signatures. */
function verifyCommits(array $input): array
{
    $repo = value($input, 'repo');
    $base = git($repo, ['rev-parse', '--verify', value($input, 'base') . '^{commit}']);
    $head = git($repo, ['rev-parse', '--verify', value($input, 'head') . '^{commit}']);
    if (command(['git', '-C', $repo, 'merge-base', '--is-ancestor', $base, $head])['code'] !== 0) {
        throw new RuntimeException('Commit range is not a forward history.');
    }
    $commits = git($repo, ['rev-list', $base . '..' . $head]);
    $email = isset($input['email']) ? value($input, 'email') : git($repo, ['config', 'user.email']);
    if ($email === '') {
        throw new RuntimeException('Commit author email is required.');
    }
    $verified = [];
    foreach ($commits === '' ? [] : explode("\n", $commits) as $sha) {
        if (git($repo, ['show', '-s', '--format=%ae', $sha]) !== $email || command(['git', '-C', $repo, 'verify-commit', $sha])['code'] !== 0) {
            throw new RuntimeException('Commit signature or author verification failed: ' . $sha);
        }
        $verified[] = $sha;
    }
    return ['event' => 'verified', 'commits' => $verified];
}

/** Dispatch portable mechanics; semantic approvals remain the lifecycle owner's job. */
function dispatch(array $input): array
{
    switch (value($input, 'action')) {
        case 'snapshot':
            return snapshot($input);
        case 'brief':
            return buildBrief($input);
        case 'record':
            return appendRecord($input);
        case 'reuse-review':
            return reuseReview($input);
        case 'automation-poll':
            return automationPoll($input);
        case 'automation-assess':
            return automationAssess($input);
        case 'inspect':
            return inspectRepo(value($input, 'repo'));
        case 'guard':
            return guard($input);
        case 'wait':
            return waitStatus($input);
        case 'delta':
            return delta($input);
        case 'transition':
            return transition($input);
        case 'lock':
            return lockAction($input);
        case 'verify-commits':
            return verifyCommits($input);
        case 'write':
            $data = $input['data'] ?? null;
            if (!is_array($data)) {
                throw new RuntimeException('Data must be a JSON object or array.');
            }
            atomicWrite(value($input, 'path'), json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n");
            return ['event' => 'written'];
        case 'worktree-create':
            $repo = value($input, 'repo');
            $branch = value($input, 'branch');
            git($repo, ['check-ref-format', '--branch', $branch]);
            $base = git($repo, ['rev-parse', '--verify', value($input, 'base') . '^{commit}']);
            git($repo, ['worktree', 'add', '-b', $branch, value($input, 'path'), $base]);
            return ['event' => 'created', 'head' => $base];
        case 'cleanup-check':
            $state = guard($input);
            return ['event' => $state['clean_including_ignored'] ? 'removable_locally' : 'preserve', 'entries' => $state['status_entries']];
        default:
            throw new RuntimeException('Unknown action.');
    }
}

try {
    $input = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($input)) {
        throw new RuntimeException('Expected JSON input object.');
    }
    echo json_encode(['ok' => true, 'result' => dispatch($input)], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
} catch (Throwable $error) {
    echo json_encode(['ok' => false, 'event' => 'blocked', 'error' => $error->getMessage()], JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
    exit(1);
}
