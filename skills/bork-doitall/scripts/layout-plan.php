<?php

declare(strict_types=1);

/** Plan stable role slots inside the coordinator's original rectangle. */
function borkLayoutPlan(int $concurrency, array $area, int $gap = 1): array
{
    if (!in_array($gap, [0, 1], true)) {
        throw new RuntimeException('Layout separator must be zero or one cell.');
    }
    if ($concurrency < 1 || $concurrency > 3) {
        throw new RuntimeException('Layout concurrency must be 1, 2 or 3.');
    }
    foreach (['x', 'y', 'width', 'height'] as $key) {
        if (!isset($area[$key]) || !is_int($area[$key]) || $area[$key] < ($key === 'width' || $key === 'height' ? 1 : 0)) {
            throw new RuntimeException('Layout needs verified integer pane geometry.');
        }
    }
    $left = max(20, (int) floor(($area['width'] - 2 * $gap) * 0.22));
    $workers = $area['width'] - $left - $gap;
    $master = intdiv($workers - $gap, 2);
    $right = $workers - $master - $gap;
    $height = intdiv($area['height'] - ($concurrency - 1) * $gap, $concurrency);
    if ($master < 35 || $right < 35 || $height < 13) {
        throw new RuntimeException('Insufficient space for the tree: each worker needs 35 columns and 6 rows; each group needs 13 rows. Resize the coordinator area; no alternate topology will be used.');
    }
    $slots = ['coordinator' => array_replace($area, ['width' => $left])];
    $operations = [['parent' => 'coordinator', 'new' => 'master:1', 'direction' => 'right', 'size' => $workers]];
    $y = $area['y'];
    $remaining = $area['height'];
    for ($i = 1; $i <= $concurrency; $i++) {
        $row = $i === $concurrency ? $remaining : $height;
        if ($i < $concurrency) {
            $operations[] = ['parent' => 'master:' . $i, 'new' => 'master:' . ($i + 1), 'direction' => 'down', 'size' => $remaining - $row - $gap];
        }
        $slots['master:' . $i] = ['x' => $area['x'] + $left + $gap, 'y' => $y, 'width' => $master, 'height' => $row];
        $review = intdiv($row - $gap, 2);
        $slots['review:' . $i] = ['x' => $area['x'] + $left + $master + 2 * $gap, 'y' => $y, 'width' => $right, 'height' => $review];
        $slots['fix:' . $i] = array_replace($slots['review:' . $i], ['y' => $y + $review + $gap, 'height' => $row - $review - $gap]);
        $y += $row + $gap;
        $remaining -= $row + $gap;
    }
    for ($i = 1; $i <= $concurrency; $i++) {
        $operations[] = ['parent' => 'master:' . $i, 'new' => 'review:' . $i, 'direction' => 'right', 'size' => $right];
        $operations[] = ['parent' => 'review:' . $i, 'new' => 'fix:' . $i, 'direction' => 'down', 'size' => $slots['fix:' . $i]['height']];
    }
    return ['version' => 1, 'concurrency' => $concurrency, 'area' => $area, 'separator' => $gap, 'slots' => $slots, 'operations' => $operations];
}

/** Reject geometry drift before assigning or replacing a worker. */
function borkLayoutGeometry(array $expected, array $actual, int $tolerance = 0): void
{
    foreach (['x', 'y', 'width', 'height'] as $key) {
        if (!isset($actual[$key]) || !is_int($actual[$key]) || abs($expected[$key] - $actual[$key]) > $tolerance) {
            throw new RuntimeException('Layout geometry changed; reconcile resize or user edits before further launches.');
        }
    }
}
