<?php

declare(strict_types=1);

require_once __DIR__ . '/scheduler.php';
require_once __DIR__ . '/environment.php';

/** Require a nonempty string from a JSON object. */
function requiredText(array $data, string $key): string
{
    if (!isset($data[$key]) || !is_string($data[$key]) || $data[$key] === '') {
        throw new RuntimeException('Missing string: ' . $key);
    }
    return $data[$key];
}

/** Read current or legacy selected-reviewer gate evidence. */
function reviewerGateRecord(array $target): ?array
{
    return $target['phase_records']['reviewer_gate'] ?? $target['phase_records']['cspf'] ?? null;
}

/** Validate a supplied profile against its approved content hash. */
function validateReviewProfile(array $plan): void
{
    $profile = requiredText($plan, 'review_profile');
    if ($profile === 'generic') {
        return;
    }
    if ($profile[0] !== '/' || is_link($profile) || !is_file($profile) || !is_readable($profile)) {
        throw new RuntimeException('Review profile must be generic or an absolute readable regular file.');
    }
    $hash = requiredText($plan, 'review_profile_sha256');
    if (!preg_match('/^[a-f0-9]{64}$/', $hash) || !hash_equals($hash, hash_file('sha256', $profile))) {
        throw new RuntimeException('Review profile does not match its approved hash.');
    }
}

/** Read a regular JSON object without following a symbolic link. */
function jsonFile(string $path): array
{
    if (is_link($path) || !is_file($path)) {
        throw new RuntimeException('Expected regular JSON file.');
    }
    $value = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($value) || array_is_list($value)) {
        throw new RuntimeException('Expected JSON object.');
    }
    return $value;
}

/** Replace a record atomically in its existing directory. */
function publishJson(string $path, array $value): void
{
    if (is_link($path) || !is_dir(dirname($path))) {
        throw new RuntimeException('Unsafe record path.');
    }
    $temporary = tempnam(dirname($path), '.batch-');
    if ($temporary === false) {
        throw new RuntimeException('Unable to create temporary record.');
    }
    try {
        $content = json_encode($value, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT) . "\n";
        if (file_put_contents($temporary, $content) !== strlen($content) || !rename($temporary, $path)) {
            throw new RuntimeException('Unable to publish record.');
        }
    } finally {
        if (is_file($temporary)) {
            unlink($temporary);
        }
    }
}

/** Hold a local batch mutex while reading and replacing the plan. */
function lockedPlan(string $path, callable $change): array
{
    $lockPath = $path . '.state.lock';
    if (is_link($lockPath) || !is_dir(dirname($path))) {
        throw new RuntimeException('Unsafe batch lock path.');
    }
    $lock = fopen($lockPath, 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) {
        throw new RuntimeException('Unable to acquire batch lock.');
    }
    try {
        $plan = is_file($path) ? jsonFile($path) : null;
        [$updated, $result] = $change($plan);
        if ($updated !== null) {
            publishJson($path, $updated);
        }
        return $result;
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

/** Check the recorded approval against the exact displayed preview. */
function approved(array $plan): void
{
    $preview = requiredText($plan, 'approved_preview');
    $approval = $plan['approval_evidence'] ?? null;
    if (!is_array($approval) || ($approval['response'] ?? null) !== 'go' || ($approval['preview_sha256'] ?? null) !== hash('sha256', $preview)) {
        throw new RuntimeException('Approved preview and go evidence are required.');
    }
    validateEnvironmentSelection($plan);
    if (($plan['schema_version'] ?? null) !== 5 || !is_array($plan['targets'] ?? null)) {
        throw new RuntimeException('Expected a version 5 target plan.');
    }
}

/** Require a target in an expected queue state. */
function targetAt(array $plan, string $id, array $states): array
{
    $target = $plan['targets'][$id] ?? null;
    if (!is_array($target) || !in_array($target['status'] ?? null, $states, true)) {
        throw new RuntimeException('Target missing or in the wrong state.');
    }
    return $target;
}

/** Verify an observed PR and exact published head. */
function observedHead(array $input, string $pr, string $head): void
{
    $remote = $input['remote'] ?? null;
    if (!is_array($remote) || ($remote['pr_url'] ?? null) !== $pr || ($remote['head'] ?? null) !== $head) {
        throw new RuntimeException('Remote PR or head does not match recorded intent.');
    }
}

/** Accept a completed child result from the original path, including after master loss. */
function adoptChild(array &$plan, array $input): array
{
    $id = requiredText($input, 'target_id');
    $phase = requiredText($input, 'phase');
    if (!in_array($phase, ['prify', 'draft_goodcode', 'ready_goodcode'], true)) {
        throw new RuntimeException('Invalid child phase.');
    }
    $target = targetAt($plan, $id, ['running', 'waiting_review']);
    $record = $target['phase_records'][$phase] ?? null;
    if (!is_array($record) || ($record['status'] ?? null) !== 'pending') {
        throw new RuntimeException('No pending child phase to adopt.');
    }
    $result = jsonFile(requiredText($record, 'result_path'));
    if (($result['phase'] ?? null) !== $phase || ($result['status'] ?? null) !== 'complete') {
        throw new RuntimeException('Child result is missing or incomplete.');
    }
    $pr = requiredText($result, 'pr_url');
    $head = requiredText($result, 'published_head');
    if (isset($record['pr_url']) && $record['pr_url'] !== $pr) {
        throw new RuntimeException('Child PR differs from the phase intent.');
    }
    /* Goodcode may advance the head by pushing fixes; reviewed_head and the live remote are verified below. */
    if ($phase === 'prify' && isset($record['expected_head']) && $record['expected_head'] !== $head) {
        throw new RuntimeException('Child head differs from the phase intent.');
    }
    if (($result['cleanup_success'] ?? null) !== true || ($input['agent_stopped'] ?? null) !== true || ($input['descendants_stopped'] ?? null) !== true) {
        throw new RuntimeException('Child or cleanup is not confirmed complete.');
    }
    observedHead($input, $pr, $head);
    if ($phase !== 'prify' && (($result['workers_stopped'] ?? null) !== true || ($result['reviewed_head'] ?? null) !== $head)) {
        throw new RuntimeException('Goodcode review or worker evidence is incomplete.');
    }
    $record['status'] = 'complete';
    $record['pr_url'] = $pr;
    $record['published_head'] = $head;
    $record['completed_at'] = gmdate('c');
    $target['phase_records'][$phase] = $record;
    $target['pr_url'] = $pr;
    $target['published_head'] = $head;
    $plan['targets'][$id] = $target;
    return ['event' => 'phase_complete', 'target_id' => $id, 'phase' => $phase, 'head' => $head];
}

/** Return the next safe action for a target without inferring remote facts. */
function inspectTarget(array $plan, string $id): array
{
    $target = targetAt($plan, $id, ['queued', 'starting', 'running', 'waiting_review', 'complete', 'blocked', 'skipped']);
    foreach ($target['mutations'] ?? [] as $kind => $mutation) {
        if (($mutation['status'] ?? null) === 'pending') {
            return ['event' => 'reconcile_mutation', 'kind' => $kind, 'intent' => $mutation];
        }
    }
    foreach ($target['phase_records'] ?? [] as $phase => $record) {
        if (($record['status'] ?? null) === 'pending') {
            return ['event' => 'reconcile_phase', 'phase' => $phase, 'result_path' => $record['result_path']];
        }
    }
    return ['event' => 'state', 'status' => $target['status']];
}

/** Resume one blocked target without replacing approval, phase or mutation evidence. */
function resumeTarget(array &$plan, array $input): array
{
    $id = requiredText($input, 'target_id');
    $target = targetAt($plan, $id, ['blocked']);
    $evidencePath = requiredText($input, 'evidence_path');
    $evidence = jsonFile($evidencePath);
    foreach (['user_continuation', 'scope_unchanged', 'prior_master_stopped', 'children_reconciled'] as $flag) {
        if (($evidence[$flag] ?? null) !== true) {
            throw new RuntimeException('Resume evidence missing: ' . $flag);
        }
    }
    requiredText($evidence, 'user_instruction');
    $agent = requiredText($input, 'agent_id');
    if (($evidence['batch_id'] ?? null) !== $plan['batch_id'] || ($evidence['target_id'] ?? null) !== $id
        || ($evidence['approved_preview_sha256'] ?? null) !== hash('sha256', $plan['approved_preview'])
        || ($evidence['prior_master_agent_id'] ?? null) !== ($target['master_agent_id'] ?? null)
        || ($evidence['recovered_master_agent_id'] ?? null) !== $agent) {
        throw new RuntimeException('Resume identity or approval differs from the blocked target.');
    }
    foreach ($target['mutations'] ?? [] as $mutation) {
        if (($mutation['status'] ?? null) === 'pending') {
            throw new RuntimeException('Reconcile uncertain mutations before resuming a target.');
        }
    }
    foreach ($target['depends_on'] as $dependency) {
        if ($plan['targets'][$dependency]['status'] !== 'complete') {
            throw new RuntimeException('Resume dependency is not complete.');
        }
    }
    if (schedule($plan)['active'] >= $plan['max_concurrency']) {
        throw new RuntimeException('No concurrency slot is available for resume.');
    }
    $pr = $target['pr_url'] ?? null;
    $head = $target['published_head'] ?? null;
    if ($pr === null && isset($target['phase_records']['prify']['result_path'])
        && is_file($target['phase_records']['prify']['result_path'])) {
        $prior = jsonFile($target['phase_records']['prify']['result_path']);
        $pr = $prior['pr_url'] ?? null;
        $head = $prior['published_head'] ?? null;
    }
    if ($pr !== null) {
        observedHead($input, $pr, $head);
        if (($input['remote']['state'] ?? null) !== 'OPEN' || ($input['remote']['is_draft'] ?? null) !== true
            || ($evidence['remote'] ?? null) !== $input['remote']) {
            throw new RuntimeException('Resume requires matching fresh open-draft PR evidence.');
        }
    }
    $target['resume_history'][] = ['blocker' => $target['blocker'] ?? null,
        'prior_master_agent_id' => $target['master_agent_id'] ?? null, 'master_agent_id' => $agent,
        'evidence_path' => $evidencePath, 'evidence_sha256' => hash_file('sha256', $evidencePath), 'resumed_at' => gmdate('c')];
    $target['status'] = 'running';
    $target['master_agent_id'] = $agent;
    $plan['targets'][$id] = $target;
    return ['event' => 'target_resumed', 'target_id' => $id];
}

/** Apply one checked transition to the approved plan. */
function changePlan(?array $plan, array $input): array
{
    $action = requiredText($input, 'action');
    if ($action === 'init') {
        if ($plan !== null) {
            throw new RuntimeException('Batch already exists; reconcile it.');
        }
        $new = $input['plan'] ?? null;
        if (!is_array($new)) {
            throw new RuntimeException('Missing approved plan.');
        }
        $new['reviewer'] = $new['reviewer'] ?? 'NONE';
        $reviewer = requiredText($new, 'reviewer');
        $skipReady = $reviewer === 'NONE';
        if (isset($new['skip_ready_goodcode']) && $new['skip_ready_goodcode'] !== $skipReady) {
            throw new RuntimeException('Reviewer and ready-goodcode skip disagree.');
        }
        $new['skip_ready_goodcode'] = $skipReady;
        $new['review_profile'] = $new['review_profile'] ?? 'generic';
        validateReviewProfile($new);
        if (isset($new['effort_override']) && !in_array($new['effort_override'], ['low', 'standard', 'high'], true)) {
            throw new RuntimeException('Effort override must be low, standard or high.');
        }
        approved($new);
        schedule($new);
        $new['state_revision'] = 0;
        return [$new, ['event' => 'initialized']];
    }
    if ($plan === null) {
        throw new RuntimeException('Batch plan missing.');
    }
    approved($plan);
    if ($action === 'inspect') {
        return [null, inspectTarget($plan, requiredText($input, 'target_id'))];
    }
    if (($input['expected_revision'] ?? null) !== ($plan['state_revision'] ?? 0)) {
        throw new RuntimeException('Plan revision changed; inspect before retrying.');
    }
    if ($action === 'reserve') {
        $selection = schedule($plan);
        foreach ($selection['blocked'] as $id => $reason) {
            $plan['targets'][$id]['status'] = 'blocked';
            $plan['targets'][$id]['blocker'] = $reason;
        }
        foreach ($selection['launch'] as $id) {
            $plan['targets'][$id]['status'] = 'starting';
        }
        $result = ['event' => 'reserved', 'launch' => $selection['launch'], 'blocked' => $selection['blocked']];
    } elseif ($action === 'started') {
        $id = requiredText($input, 'target_id');
        targetAt($plan, $id, ['starting']);
        $plan['targets'][$id]['master_agent_id'] = requiredText($input, 'agent_id');
        $plan['targets'][$id]['status'] = 'running';
        $result = ['event' => 'running', 'target_id' => $id];
    } elseif ($action === 'phase-start') {
        $id = requiredText($input, 'target_id');
        $phase = requiredText($input, 'phase');
        if (!in_array($phase, ['prify', 'draft_goodcode', 'ready_goodcode'], true)) {
            throw new RuntimeException('Invalid child phase.');
        }
        $target = targetAt($plan, $id, ['running']);
        if ($phase === 'ready_goodcode' && ($plan['skip_ready_goodcode'] ?? false) === true) {
            throw new RuntimeException('Ready goodcode is skipped by NOREVIEWER.');
        }
        if (isset($target['phase_records'][$phase])) {
            throw new RuntimeException('Phase already has a record; reconcile it.');
        }
        if ($phase === 'draft_goodcode' && !isset($target['pr_url'])) {
            throw new RuntimeException('Draft goodcode requires a verified PR.');
        }
        if ($phase === 'ready_goodcode' && isset($target['phase_records']['draft_goodcode']) && (($target['mutations']['ready']['status'] ?? null) !== 'complete' || (reviewerGateRecord($target)['status'] ?? null) !== 'complete')) {
            throw new RuntimeException('Promotion and selected-reviewer review must complete first.');
        }
        if ($phase === 'ready_goodcode' && isset($plan['reviewer']) && (reviewerGateRecord($target)['status'] ?? null) !== 'complete') {
            throw new RuntimeException('Selected-reviewer gate must complete first.');
        }
        $path = requiredText($input, 'result_path');
        if ($path[0] !== '/' || is_link($path) || file_exists($path) || !is_dir(dirname($path))) {
            throw new RuntimeException('Expected a new absolute child result path.');
        }
        $record = ['status' => 'pending', 'result_path' => $path, 'started_at' => gmdate('c')];
        foreach (['pr_url', 'expected_head'] as $field) {
            if (isset($input[$field])) {
                $record[$field] = requiredText($input, $field);
            }
        }
        $plan['targets'][$id]['phase_records'][$phase] = $record;
        $result = ['event' => 'phase_pending', 'target_id' => $id, 'phase' => $phase];
    } elseif ($action === 'phase-adopt') {
        $result = adoptChild($plan, $input);
    } elseif ($action === 'gate-complete') {
        $id = requiredText($input, 'target_id');
        $target = targetAt($plan, $id, ['running', 'waiting_review']);
        if ((isset($target['phase_records']['draft_goodcode']) && ($target['mutations']['ready']['status'] ?? null) !== 'complete') || reviewerGateRecord($target) !== null) {
            throw new RuntimeException('Promotion missing or reviewer gate already recorded.');
        }
        if (($plan['reviewer'] ?? null) === 'NONE') {
            throw new RuntimeException('Reviewer gate is skipped for NONE.');
        }
        $evidencePath = requiredText($input, 'evidence_path');
        $evidence = jsonFile($evidencePath);
        if (isset($plan['reviewer']) && ($evidence['reviewer'] ?? null) !== $plan['reviewer']) {
            throw new RuntimeException('Completion evidence does not match the selected reviewer.');
        }
        if (($evidence['status'] ?? null) !== 'complete' || ($evidence['pr_url'] ?? null) !== ($target['pr_url'] ?? null) || ($evidence['head'] ?? null) !== ($target['published_head'] ?? null)) {
            throw new RuntimeException('Reviewer completion evidence does not match the PR head.');
        }
        observedHead($input, $target['pr_url'], $target['published_head']);
        $plan['targets'][$id]['phase_records']['reviewer_gate'] = ['status' => 'complete', 'evidence_path' => $evidencePath, 'completed_at' => gmdate('c')];
        $result = ['event' => 'gate_complete', 'target_id' => $id];
    } elseif ($action === 'mutation-start') {
        $id = requiredText($input, 'target_id');
        $kind = requiredText($input, 'kind');
        if (!in_array($kind, ['ready', 'merge'], true)) {
            throw new RuntimeException('Invalid batch mutation kind.');
        }
        $target = targetAt($plan, $id, $kind === 'merge' ? ['complete'] : ['running']);
        if ($kind === 'merge' && (($plan['merge_enabled'] ?? false) !== true || ($target['merge_status'] ?? null) !== 'pending')) {
            throw new RuntimeException('Merge is not approved and pending.');
        }
        if (isset($target['mutations'][$kind])) {
            throw new RuntimeException('Mutation already recorded; reconcile it.');
        }
        $pr = requiredText($input, 'pr_url');
        $head = requiredText($input, 'expected_head');
        if (($target['pr_url'] ?? null) !== $pr || ($target['published_head'] ?? null) !== $head) {
            throw new RuntimeException('Mutation identity differs from completed phase.');
        }
        if ($kind === 'ready' && (($target['phase_records']['draft_goodcode']['status'] ?? null) !== 'complete')) {
            throw new RuntimeException('Draft goodcode is incomplete.');
        }
        if ($kind === 'merge' && ($plan['skip_ready_goodcode'] ?? false) !== true && (($target['phase_records']['ready_goodcode']['status'] ?? null) !== 'complete')) {
            throw new RuntimeException('Ready goodcode is incomplete.');
        }
        $plan['targets'][$id]['mutations'][$kind] = ['status' => 'pending', 'pr_url' => $pr, 'expected_head' => $head, 'started_at' => gmdate('c')];
        if ($kind === 'merge') {
            $plan['targets'][$id]['merge_status'] = 'starting';
        }
        $result = ['event' => 'perform_once', 'kind' => $kind, 'target_id' => $id];
    } elseif ($action === 'mutation-observe') {
        $id = requiredText($input, 'target_id');
        $kind = requiredText($input, 'kind');
        $target = targetAt($plan, $id, $kind === 'merge' ? ['complete'] : ['running']);
        $intent = $target['mutations'][$kind] ?? null;
        if (!is_array($intent) || ($intent['status'] ?? null) !== 'pending') {
            throw new RuntimeException('No pending mutation to reconcile.');
        }
        observedHead($input, requiredText($intent, 'pr_url'), requiredText($intent, 'expected_head'));
        $remote = $input['remote'];
        if ($kind === 'ready' && ($remote['is_draft'] ?? null) !== false) {
            throw new RuntimeException('Ready promotion is not verified.');
        }
        if ($kind === 'merge' && (($remote['merged'] ?? null) !== true || !is_string($remote['merge_commit_url'] ?? null) || $remote['merge_commit_url'] === '')) {
            throw new RuntimeException('Merge is not verified.');
        }
        $plan['targets'][$id]['mutations'][$kind]['status'] = 'complete';
        $plan['targets'][$id]['mutations'][$kind]['completed_at'] = gmdate('c');
        if ($kind === 'merge') {
            $plan['targets'][$id]['merge_status'] = 'merged';
            $plan['targets'][$id]['merge_commit_url'] = $remote['merge_commit_url'];
        }
        $result = ['event' => 'mutation_complete', 'kind' => $kind, 'target_id' => $id];
    } elseif ($action === 'merge-running') {
        $id = requiredText($input, 'target_id');
        $target = targetAt($plan, $id, ['complete']);
        if (($target['merge_status'] ?? null) !== 'starting' || ($target['mutations']['merge']['status'] ?? null) !== 'pending') {
            throw new RuntimeException('No starting merge to mark running.');
        }
        $plan['targets'][$id]['merge_status'] = 'running';
        $result = ['event' => 'merge_running', 'target_id' => $id];
    } elseif ($action === 'target-complete') {
        $id = requiredText($input, 'target_id');
        $target = targetAt($plan, $id, ['running', 'waiting_review']);
        $skipReady = ($plan['skip_ready_goodcode'] ?? false) === true;
        if ((!$skipReady && ($target['phase_records']['ready_goodcode']['status'] ?? null) !== 'complete') || ($input['master_stopped'] ?? null) !== true || ($input['descendants_stopped'] ?? null) !== true) {
            throw new RuntimeException('Target result or agents are incomplete.');
        }
        if ($skipReady && (isset($target['phase_records']['ready_goodcode']) || (($input['remote']['is_draft'] ?? null) !== false) || (!isset($plan['reviewer']) && isset($target['mutations']['ready']) && (reviewerGateRecord($target)['status'] ?? null) !== 'complete'))) {
            throw new RuntimeException('NOREVIEWER requires a ready PR and completed promotion gate.');
        }
        if ($skipReady && (isset($target['phase_records']['prify']) || in_array($target['entry_phase'] ?? null, ['prify', 'draft', 'draft_goodcode'], true)) && ($target['phase_records']['draft_goodcode']['status'] ?? null) !== 'complete') {
            throw new RuntimeException('Draft goodcode is incomplete.');
        }
        if ($skipReady && isset($target['phase_records']['draft_goodcode']) && ($target['mutations']['ready']['status'] ?? null) !== 'complete') {
            throw new RuntimeException('Draft PR promotion is incomplete.');
        }
        if (isset($target['mutations']['ready']) && ($target['mutations']['ready']['status'] ?? null) !== 'complete') {
            throw new RuntimeException('Ready promotion is unresolved.');
        }
        $report = jsonFile(requiredText($input, 'result_path'));
        if (($report['status'] ?? null) !== 'complete' || ($report['pr_url'] ?? null) !== ($target['pr_url'] ?? null) || ($report['published_head'] ?? null) !== ($target['published_head'] ?? null) || ($report['cleanup_success'] ?? null) !== true) {
            throw new RuntimeException('Target result identity or cleanup is incomplete.');
        }
        if ($skipReady && ($report['ready_goodcode_status'] ?? null) !== 'skipped_noreviewer') {
            throw new RuntimeException('NOREVIEWER skip is missing from the target result.');
        }
        observedHead($input, $target['pr_url'], $target['published_head']);
        $plan['targets'][$id]['status'] = 'complete';
        $plan['targets'][$id]['result_path'] = $input['result_path'];
        $plan['targets'][$id]['merge_status'] = ($plan['merge_enabled'] ?? false) === true ? 'pending' : 'skipped_not_requested';
        $result = ['event' => 'target_complete', 'target_id' => $id];
    } elseif ($action === 'target-resume') {
        $result = resumeTarget($plan, $input);
    } elseif ($action === 'target-blocked') {
        $id = requiredText($input, 'target_id');
        targetAt($plan, $id, ['starting', 'running', 'waiting_review']);
        if (($input['master_stopped'] ?? null) !== true || ($input['descendants_stopped'] ?? null) !== true) {
            throw new RuntimeException('Active agents must stop before releasing the target slot.');
        }
        $plan['targets'][$id]['status'] = 'blocked';
        $plan['targets'][$id]['blocker'] = ['reason' => requiredText($input, 'reason'), 'evidence_path' => requiredText($input, 'evidence_path')];
        jsonFile($input['evidence_path']);
        $result = ['event' => 'target_blocked', 'target_id' => $id];
    } elseif ($action === 'merge-blocked') {
        $id = requiredText($input, 'target_id');
        $target = targetAt($plan, $id, ['complete']);
        if (!in_array($target['merge_status'] ?? null, ['pending', 'starting', 'running'], true)) {
            throw new RuntimeException('Merge is not pending.');
        }
        if (($target['mutations']['merge']['status'] ?? null) === 'pending') {
            observedHead($input, $target['pr_url'], $target['published_head']);
            if (($input['remote']['merged'] ?? null) !== false) {
                throw new RuntimeException('Uncertain merge must be reconciled first.');
            }
            $plan['targets'][$id]['mutations']['merge']['status'] = 'blocked';
        }
        $plan['targets'][$id]['merge_status'] = 'blocked';
        $plan['targets'][$id]['merge_blocker'] = requiredText($input, 'reason');
        $result = ['event' => 'merge_blocked', 'target_id' => $id];
    } else {
        throw new RuntimeException('Unknown batch action.');
    }
    $plan['state_revision'] = ($plan['state_revision'] ?? 0) + 1;
    return [$plan, $result + ['state_revision' => $plan['state_revision']]];
}

try {
    $inputPath = $argv[1] ?? '';
    $input = jsonFile($inputPath);
    $result = lockedPlan(requiredText($input, 'plan_path'), static fn (?array $plan): array => changePlan($plan, $input));
    echo json_encode(['ok' => true, 'result' => $result], JSON_THROW_ON_ERROR) . "\n";
} catch (Throwable $error) {
    echo json_encode(['ok' => false, 'event' => 'blocked', 'error' => $error->getMessage()], JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
    exit(1);
}
