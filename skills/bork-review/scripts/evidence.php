<?php

declare(strict_types=1);

/** Canonicalize maps without changing positional list ordering. */
function canonical($data)
{
    if (!is_array($data)) {
        return $data;
    }
    if ($data !== [] && array_keys($data) !== range(0, count($data) - 1)) {
        ksort($data);
    }
    return array_map('canonical', $data);
}

/** Hash evidence with deterministic map ordering. */
function evidenceHash($data): string
{
    return hash('sha256', json_encode(canonical($data), JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
}

/** Read an explicit JSON path, rejecting missing evidence. */
function atPath(array $data, array $path)
{
    $value = $data;
    foreach ($path as $key) {
        if (!is_array($value) || !array_key_exists($key, $value)) {
            throw new RuntimeException('Missing evidence path.');
        }
        $value = $value[$key];
    }
    return $value;
}

/** Capture a read-only API call within a bounded wall-clock limit. */
function fetchCommand(array $args, int $seconds): string
{
    $errors = fopen('php://temp', 'w+');
    $process = proc_open($args, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => $errors], $pipes);
    if (!is_resource($process)) {
        fclose($errors);
        throw new RuntimeException('Unable to start evidence fetch.');
    }
    fclose($pipes[0]);
    stream_set_blocking($pipes[1], false);
    $deadline = microtime(true) + $seconds;
    $output = '';
    try {
        do {
            $output .= stream_get_contents($pipes[1]);
            $status = proc_get_status($process);
            if (!$status['running']) {
                $output .= stream_get_contents($pipes[1]);
                break;
            }
            if (microtime(true) >= $deadline) {
                proc_terminate($process, 9);
                throw new RuntimeException('Evidence fetch timed out; preserve the last complete snapshot.');
            }
            usleep(10000);
        } while (true);
    } finally {
        fclose($pipes[1]);
        proc_close($process);
        fclose($errors);
    }
    if ($status['exitcode'] !== 0) {
        throw new RuntimeException('Evidence fetch failed; preserve the last complete snapshot.');
    }
    return $output;
}

/** Reject nested incomplete connections except the explicitly paginated connection. */
function checkConnections(array $data, array $paginatedPath, array $path = []): void
{
    if (isset($data['pageInfo'])) {
        if (!is_array($data['pageInfo']) || !is_bool($data['pageInfo']['hasNextPage'] ?? null)) {
            throw new RuntimeException('Invalid connection page information.');
        }
        if ($data['pageInfo']['hasNextPage'] && $path !== $paginatedPath) {
            throw new RuntimeException('Nested connection is incomplete; fetch it separately.');
        }
    }
    foreach ($data as $key => $child) {
        if (is_array($child)) {
            checkConnections($child, $paginatedPath, array_merge($path, [$key]));
        }
    }
}

/** Fetch a complete read-only source and retain raw and normalized snapshots. */
function snapshot(array $input): array
{
    $spec = readJson(value($input, 'spec'));
    $host = value($spec, 'host');
    $repository = value($spec, 'repository');
    $endpoint = value($spec, 'endpoint');
    if (!preg_match('/^[a-zA-Z0-9.-]+$/', $host) || !preg_match('~^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$~', $repository)) {
        throw new RuntimeException('Invalid explicit repository identity.');
    }
    $args = ['gh', 'api', '--hostname', $host, '--paginate', '--slurp'];
    $graphql = $endpoint === 'graphql';
    if ($graphql) {
        $query = value($spec, 'query');
        if (!preg_match('/^\s*query\b/', $query) || preg_match('/\bmutation\b/i', $query) || !str_contains($query, '$owner') || !str_contains($query, '$name')) {
            throw new RuntimeException('Use an explicit read-only query binding owner and name.');
        }
        [$owner, $name] = explode('/', $repository);
        $args = array_merge($args, ['graphql', '-f', 'query=' . $query, '-f', 'owner=' . $owner, '-f', 'name=' . $name]);
        foreach ($spec['variables'] ?? [] as $key => $variable) {
            if (in_array($key, ['owner', 'name', 'query', 'endCursor'], true) || !preg_match('/^[a-zA-Z][a-zA-Z0-9_]*$/', $key) || (!is_string($variable) && !is_int($variable))) {
                throw new RuntimeException('Invalid query variable.');
            }
            $args = array_merge($args, [is_int($variable) ? '-F' : '-f', $key . '=' . $variable]);
        }
    } else {
        if (!str_starts_with($endpoint, 'repos/' . $repository . '/') || str_contains($endpoint, '..') || str_contains($endpoint, '%')) {
            throw new RuntimeException('Endpoint must address the recorded repository.');
        }
        $args = array_merge($args, ['--method', 'GET', $endpoint]);
    }
    $raw = fetchCommand($args, max(1, min(40, (int) ($input['seconds'] ?? 20))));
    $pages = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($pages) || !$pages) {
        throw new RuntimeException('Missing API pages.');
    }
    $entries = [];
    $path = $spec['items_path'] ?? [];
    $connection = $spec['connection_path'] ?? [];
    foreach ($pages as $pageIndex => $page) {
        if (!is_array($page) || isset($page['errors']) || ($graphql && !isset($page['data']))) {
            throw new RuntimeException('Incomplete API result.');
        }
        if ($graphql) {
            checkConnections($page, $connection);
            if ($connection) {
                $pageInfo = atPath($page, array_merge($connection, ['pageInfo']));
                if (($pageInfo['hasNextPage'] ?? null) !== ($pageIndex < count($pages) - 1)) {
                    throw new RuntimeException('Pagination did not reach a complete final page.');
                }
            }
        }
        $items = atPath($page, $path);
        if (($spec['single'] ?? false) === true) {
            $items = [$items];
        }
        if (!is_array($items)) {
            throw new RuntimeException('Expected source entries.');
        }
        foreach ($items as $entry) {
            if (!is_array($entry)) {
                throw new RuntimeException('Invalid source entry.');
            }
            $id = isset($spec['single_id']) ? value($spec, 'single_id') : atPath($entry, $spec['id_path'] ?? ['id']);
            if ((!is_string($id) && !is_int($id)) || (string) $id === '') {
                throw new RuntimeException('Missing stable source ID.');
            }
            $id = (string) $id;
            $entry = canonical($entry);
            if (array_key_exists($id, $entries) && $entries[$id] !== $entry) {
                throw new RuntimeException('Source changed during pagination; retry a complete fetch.');
            }
            $entries[$id] = $entry;
        }
    }
    ksort($entries);
    $identity = evidenceHash($spec);
    $previous = isset($input['previous']) ? readJson(value($input, 'previous')) : null;
    if ($previous !== null && (($previous['complete'] ?? false) !== true || ($previous['source_hash'] ?? '') !== $identity)) {
        throw new RuntimeException('Previous snapshot has different or incomplete source identity.');
    }
    $old = $previous['entries'] ?? [];
    $changed = [];
    foreach ($entries as $id => $entry) {
        if (!array_key_exists($id, $old) || $old[$id] !== $entry) {
            $changed[] = (string) $id;
        }
    }
    $removed = array_map('strval', array_values(array_diff(array_keys($old), array_keys($entries))));
    $destination = value($input, 'path');
    if (file_exists($destination) || is_link($destination) || file_exists($destination . '.raw.json') || is_link($destination . '.raw.json')) {
        throw new RuntimeException('Snapshot destination must be new.');
    }
    $record = ['schema_version' => 1, 'complete' => true, 'source_hash' => $identity, 'fetched_at' => gmdate('c'), 'entries_hash' => evidenceHash($entries), 'entries' => (object) $entries];
    atomicWrite($destination . '.raw.json', $raw);
    atomicWrite($destination, json_encode($record, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    return ['event' => $previous === null || $changed || $removed ? 'changed' : 'unchanged', 'path' => $destination, 'hash' => $record['entries_hash'], 'changed_ids' => $changed, 'removed_ids' => $removed, 'count' => count($entries)];
}

/** Build a role brief from saved identity and explicit phase fields. */
function buildBrief(array $input): array
{
    $session = readJson(value($input, 'session'));
    $overlay = $input['data'] ?? [];
    if (!is_array($overlay)) {
        throw new RuntimeException('Brief fields must be an object.');
    }
    foreach (['run_id', 'worktree', 'branch', 'base_repository', 'head_repository', 'pr_url', 'issue_url'] as $key) {
        if (isset($session[$key], $overlay[$key]) && $session[$key] !== $overlay[$key]) {
            throw new RuntimeException('Brief changes session identity: ' . $key);
        }
    }
    $fields = ['run_id', 'mode', 'review_mode', 'role', 'worktree', 'branch', 'head', 'base_sha', 'base_repository', 'head_repository', 'pr_url', 'issue_url', 'cycle', 'pass', 'context_path', 'review_path', 'previous_review_path', 'instruction_paths', 'validation_path', 'execution_driver', 'master_agent_id', 'cli_profile', 'master_pane', 'commit_email', 'base_override', 'baseline_path', 'worker_session_id'];
    $brief = ['schema_version' => 1, 'session_path' => value($input, 'session')];
    foreach ($fields as $key) {
        $brief[$key] = $overlay[$key] ?? $session[$key] ?? null;
    }
    foreach (['run_id', 'role', 'worktree', 'branch', 'head', 'base_sha', 'base_repository', 'head_repository'] as $key) {
        value($brief, $key);
    }
    if (!in_array($brief['role'], ['review', 'fix', 'prify', 'target_master'], true) || (!$brief['pr_url'] && !$brief['issue_url'])) {
        throw new RuntimeException('Invalid role or missing target.');
    }
    atomicWrite(value($input, 'path'), json_encode($brief, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    return ['event' => 'written', 'path' => value($input, 'path')];
}

/** Append idempotent outcomes under a lock while retaining previous attempts. */
function appendRecord(array $input): array
{
    $path = value($input, 'path');
    $id = value($input, 'id');
    $data = $input['data'] ?? null;
    if (!is_array($data)) {
        throw new RuntimeException('Record data must be an object.');
    }
    $lock = $path . '.lock';
    if (!@mkdir($lock, 0700)) {
        throw new RuntimeException('Record is locked; reconcile before retrying.');
    }
    try {
        $records = file_exists($path) ? readJson($path) : [];
        if (array_key_exists($id, $records)) {
            if (canonical($records[$id]) !== canonical($data)) {
                throw new RuntimeException('Outcome already recorded; use a new attempt ID.');
            }
            return ['event' => 'unchanged', 'path' => $path, 'id' => $id];
        }
        $records[$id] = $data;
        atomicWrite($path, json_encode((object) $records, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    } finally {
        rmdir($lock);
    }
    return ['event' => 'recorded', 'path' => $path, 'id' => $id];
}

/** Identify candidate review reuse without granting review acceptance. */
function reuseReview(array $input): array
{
    $old = readJson(value($input, 'previous'));
    $new = readJson(value($input, 'current'));
    foreach (['pr_url', 'base_repository', 'head_repository', 'base_sha', 'instruction_hash', 'intent_hash'] as $key) {
        if (empty($old[$key]) || empty($new[$key]) || $old[$key] !== $new[$key]) {
            return ['event' => 'full_review', 'reason' => 'changed_or_missing_' . $key];
        }
    }
    if (($old['complete'] ?? false) !== true || ($new['context_complete'] ?? false) !== true || empty($old['review_path']) || !is_file($old['review_path'])) {
        return ['event' => 'full_review', 'reason' => 'missing_coverage_or_context'];
    }
    $repo = value($input, 'repo');
    $head = value($new, 'head');
    $baseline = value($old, 'reviewed_head');
    guard(['repo' => $repo, 'branch' => value($new, 'branch'), 'head' => $head]);
    if (git($repo, ['status', '--porcelain=v1', '--untracked-files=no']) !== '') {
        return ['event' => 'full_review', 'reason' => 'dirty_tracked_content'];
    }
    if (command(['git', '-C', $repo, 'merge-base', '--is-ancestor', $baseline, $head])['code'] !== 0) {
        return ['event' => 'full_review', 'reason' => 'missing_or_diverged_baseline'];
    }
    return ['event' => $baseline === $head ? 'reuse_candidate' : 'delta_candidate', 'review_path' => $old['review_path'], 'reviewed_head' => $baseline, 'reason' => 'identity_and_context_match'];
}
