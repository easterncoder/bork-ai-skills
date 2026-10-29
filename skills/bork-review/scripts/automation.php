<?php

declare(strict_types=1);

/** Reduce assessed scoped evidence into a conservative completion event. */
function automationEvent(array &$state, array $scope, int $now): array
{
    $assessment = $state['assessment'] ?? null;
    if (!is_array($assessment) || ($assessment['evidence_hash'] ?? '') !== ($state['evidence_hash'] ?? null)) {
        return ['event' => 'changed', 'reason' => 'assessment_required'];
    }
    if (($assessment['head'] ?? '') !== value($scope, 'head')) {
        throw new RuntimeException('Automation HEAD changed; reconcile scope.');
    }
    if (!is_bool($assessment['draft'] ?? null)) {
        throw new RuntimeException('Fresh draft state is required.');
    }
    if ($assessment['draft']) {
        return ['event' => 'skipped_draft'];
    }
    $pending = [];
    $failed = [];
    $started = ($state['review_started'] ?? false) === true;
    $hasBot = false;
    foreach ($scope['signals'] as $requirement) {
        $hasBot = $hasBot || $requirement['kind'] !== 'check';
    }
    $quiet = !$hasBot;
    foreach ($scope['signals'] as $id => $requirement) {
        $signal = $assessment['signals'][$id] ?? null;
        if ($signal === null) {
            $pending[] = $id;
            continue;
        }
        if (($signal['head'] ?? '') !== $scope['head'] || empty($signal['evidence'])) {
            throw new RuntimeException('Signal lacks SHA-correlated evidence: ' . $id);
        }
        if (($scope['mode'] ?? '') === 'promotion' && ($signal['event_id'] ?? '') !== value($scope, 'event_id')) {
            throw new RuntimeException('Signal is not correlated with this ready event.');
        }
        $status = $signal['status'] ?? '';
        if (!in_array($status, ['missing', 'pending', 'terminal', 'blocked'], true)) {
            throw new RuntimeException('Invalid signal status.');
        }
        if ($status === 'blocked') {
            throw new RuntimeException('Scoped automation is blocked: ' . $id);
        }
        $signalStarted = ($signal['started'] ?? false) === true
            || ($requirement['kind'] === 'review' && $status === 'terminal' && ($signal['completed_review'] ?? false) === true);
        if ($scope['mode'] === 'promotion' && $signalStarted && !$started) {
            if (!is_int($signal['started_at'] ?? null) || $signal['started_at'] > $now || $signal['started_at'] > $scope['promotion_time'] + 600) {
                throw new RuntimeException('Review start time is missing or outside the promotion startup deadline.');
            }
        }
        $started = $started || $signalStarted;
        if ($status !== 'terminal') {
            $pending[] = $id;
        } elseif ($requirement['kind'] === 'review' && ($signal['completed_review'] ?? false) !== true) {
            throw new RuntimeException('Explicit review completion evidence is missing.');
        }
        if ($requirement['kind'] === 'quiet_review') {
            $quiet = true;
        }
        if (($signal['failed'] ?? false) === true) {
            if ($requirement['kind'] !== 'check') {
                throw new RuntimeException('Review automation failed without a completed review.');
            }
            $failed[] = $id;
        }
    }
    $state['review_started'] = $started;
    if (($scope['mode'] ?? '') === 'promotion' && !$started && $now >= (int) $scope['promotion_time'] + 600) {
        throw new RuntimeException('No correlated review started within ten minutes of promotion.');
    }
    $activity = value($assessment, 'activity_hash');
    if (($state['activity_hash'] ?? '') !== $activity) {
        $state['activity_hash'] = $activity;
        $state['quiet_since'] = $now;
    }
    if ($pending) {
        /* Start the quiet interval only after all required signals are terminal. */
        $state['quiet_since'] = $now;
        return ['event' => 'waiting', 'pending' => $pending];
    }
    if ($quiet && $now - ($state['quiet_since'] ?? $now) < 120) {
        return ['event' => 'waiting', 'quiet_remaining' => 120 - ($now - $state['quiet_since'])];
    }
    return ['event' => 'complete', 'failed_checks' => $failed];
}

/** Load and validate immutable polling scope and its saved state. */
function automationContext(array $input): array
{
    $scope = readJson(value($input, 'scope'));
    value($scope, 'head');
    if (!in_array($scope['mode'] ?? '', ['follow_up', 'promotion'], true) || !is_array($scope['sources'] ?? null) || !$scope['sources'] || !is_array($scope['signals'] ?? null)) {
        throw new RuntimeException('Incomplete automation scope.');
    }
    foreach ($scope['signals'] as $signal) {
        if (!is_array($signal) || !in_array($signal['kind'] ?? '', ['check', 'review', 'quiet_review'], true)) {
            throw new RuntimeException('Invalid automation requirement.');
        }
    }
    if ($scope['mode'] === 'promotion') {
        value($scope, 'event_id');
        if (!is_int($scope['promotion_time'] ?? null) || count($scope['signals']) !== 1 || reset($scope['signals'])['kind'] !== 'review') {
            throw new RuntimeException('Promotion requires one explicit reviewer and a saved promotion time.');
        }
    }
    $state = file_exists(value($input, 'state')) ? readJson($input['state']) : [];
    if ($state && ($state['scope_hash'] ?? '') !== evidenceHash($scope)) {
        throw new RuntimeException('Automation scope changed; start a reconciled scope.');
    }
    $state['scope_hash'] = evidenceHash($scope);
    return [$scope, $state];
}

/** Poll complete snapshots once, reusing assessments only for identical evidence. */
function automationPoll(array $input): array
{
    [$scope, $state] = automationContext($input);
    $deadline = microtime(true) + 45;
    $snapshots = [];
    $hashes = [];
    $changes = [];
    foreach ($scope['sources'] as $id => $spec) {
        $remaining = (int) floor($deadline - microtime(true));
        if ($remaining < 1) {
            throw new RuntimeException('Poll exceeded its bounded budget; retain prior state.');
        }
        $request = ['spec' => $spec, 'path' => value($input, 'directory') . '/snapshot-' . bin2hex(random_bytes(8)) . '.json', 'seconds' => min(20, $remaining)];
        if (isset($state['snapshots'][$id])) {
            $request['previous'] = $state['snapshots'][$id];
        }
        $result = snapshot($request);
        $snapshots[$id] = $result['path'];
        $hashes[$id] = $result['hash'];
        if ($result['event'] === 'changed') {
            $changes[$id] = $result;
        }
    }
    if (isset($state['polled_at']) && time() - $state['polled_at'] > 60) {
        $state['quiet_since'] = time();
    }
    $state['snapshots'] = $snapshots;
    $state['evidence_hash'] = evidenceHash($hashes);
    $state['polled_at'] = time();
    $result = automationEvent($state, $scope, time());
    atomicWrite(value($input, 'state'), json_encode($state, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    return $result + ['state' => $input['state'], 'evidence_hash' => $state['evidence_hash'], 'changes' => (object) $changes];
}

/** Save a scoped semantic assessment against exactly the last complete poll. */
function automationAssess(array $input): array
{
    [$scope, $state] = automationContext($input);
    $assessment = readJson(value($input, 'assessment'));
    if (empty($state['evidence_hash']) || ($assessment['evidence_hash'] ?? '') !== $state['evidence_hash'] || time() - ($state['polled_at'] ?? 0) > 60) {
        throw new RuntimeException('Assessment is stale; poll again before recording it.');
    }
    $state['assessment'] = $assessment;
    $result = automationEvent($state, $scope, time());
    atomicWrite(value($input, 'state'), json_encode($state, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    return $result + ['state' => $input['state']];
}
