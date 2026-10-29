<?php

declare(strict_types=1);

/** Mark queued targets whose prerequisites are already blocked. */
function propagateBlocked(array $targets, array &$blocked): void
{
    do {
        $changed = false;
        foreach ($targets as $id => $target) {
            if ($target['status'] !== 'queued' || isset($blocked[$id])) {
                continue;
            }
            foreach ($target['depends_on'] as $parent) {
                if (in_array($targets[$parent]['status'], ['blocked', 'skipped'], true) || isset($blocked[$parent])) {
                    $blocked[$id] = ['reason' => 'dependency_blocked', 'dependency' => $parent];
                    $changed = true;
                    break;
                }
            }
        }
    } while ($changed);
}

/** Find queued nodes in a dependency cycle without changing target state. */
function visitCycles(string $id, array $targets, array &$state, array &$stack, array &$blocked): void
{
    $state[$id] = 1;
    $stack[] = $id;
    foreach ($targets[$id]['depends_on'] as $parent) {
        if ($targets[$parent]['status'] !== 'queued' || isset($blocked[$parent])) {
            continue;
        }
        if (!isset($state[$parent])) {
            visitCycles($parent, $targets, $state, $stack, $blocked);
        } elseif ($state[$parent] === 1) {
            $cycle = array_slice($stack, array_search($parent, $stack, true));
            foreach ($cycle as $member) {
                $blocked[$member] = ['reason' => 'dependency_cycle', 'cycle' => $cycle];
            }
        }
    }
    array_pop($stack);
    $state[$id] = 2;
}

/** Return dependency-ready targets and explicit blocked queue entries. */
function schedule(array $data): array
{
    $limit = $data['max_concurrency'] ?? 1;
    if (!is_int($limit) || $limit < 1 || $limit > 3) {
        throw new RuntimeException('max_concurrency must be an integer from one to three.');
    }
    $targets = $data['targets'] ?? null;
    if (!is_array($targets)) {
        throw new RuntimeException('Missing target map.');
    }
    $active = 0;
    foreach ($targets as $id => $target) {
        if (!is_array($target) || !in_array($target['status'] ?? '', ['queued', 'starting', 'running', 'waiting_review', 'complete', 'blocked', 'skipped'], true)) {
            throw new RuntimeException('Invalid target state.');
        }
        if (in_array($target['status'], ['starting', 'running', 'waiting_review'], true)) {
            $active++;
        }
        if (!is_array($target['depends_on'] ?? null)) {
            throw new RuntimeException('Missing dependencies.');
        }
        foreach ($target['depends_on'] as $parent) {
            if (!is_string($parent) || !isset($targets[$parent]) || (string) $id === $parent) {
                throw new RuntimeException('Invalid or unresolved dependency.');
            }
        }
    }
    $blocked = [];
    propagateBlocked($targets, $blocked);
    $state = [];
    $stack = [];
    foreach ($targets as $id => $target) {
        if ($target['status'] === 'queued' && !isset($blocked[$id]) && !isset($state[$id])) {
            visitCycles((string) $id, $targets, $state, $stack, $blocked);
        }
    }
    propagateBlocked($targets, $blocked);
    $ready = [];
    $waiting = [];
    foreach ($targets as $id => $target) {
        if ($target['status'] !== 'queued' || isset($blocked[$id])) {
            continue;
        }
        $satisfied = true;
        foreach ($target['depends_on'] as $parent) {
            if ($targets[$parent]['status'] !== 'complete') {
                $satisfied = false;
            }
        }
        if ($satisfied && count($ready) < $limit - $active) {
            $ready[] = (string) $id;
        } else {
            $waiting[] = (string) $id;
        }
    }
    return ['active' => $active, 'launch' => $ready, 'waiting' => $waiting, 'blocked' => (object) $blocked];
}
