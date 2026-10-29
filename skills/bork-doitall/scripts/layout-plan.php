<?php

declare(strict_types=1);

/** Plan stable role slots inside the coordinator's original rectangle. */
function borkLayoutPlan(int $concurrency, array $area): array
{
    if ($concurrency < 1 || $concurrency > 3) {
        throw new RuntimeException('Layout concurrency must be 1, 2 or 3.');
    }
    foreach (['x', 'y', 'width', 'height'] as $key) {
        if (!isset($area[$key]) || !is_int($area[$key]) || $area[$key] < ($key === 'width' || $key === 'height' ? 1 : 0)) {
            throw new RuntimeException('Layout needs verified integer pane geometry.');
        }
    }
    $left = max(20, (int) floor(($area['width'] - 2) * 0.22));
    $workers = $area['width'] - $left - 1;
    $master = intdiv($workers - 1, 2);
    $right = $workers - $master - 1;
    $height = intdiv($area['height'] - $concurrency + 1, $concurrency);
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
            $operations[] = ['parent' => 'master:' . $i, 'new' => 'master:' . ($i + 1), 'direction' => 'down', 'size' => $remaining - $row - 1];
        }
        $slots['master:' . $i] = ['x' => $area['x'] + $left + 1, 'y' => $y, 'width' => $master, 'height' => $row];
        $review = intdiv($row - 1, 2);
        $slots['review:' . $i] = ['x' => $area['x'] + $left + $master + 2, 'y' => $y, 'width' => $right, 'height' => $review];
        $slots['fix:' . $i] = array_replace($slots['review:' . $i], ['y' => $y + $review + 1, 'height' => $row - $review - 1]);
        $y += $row + 1;
        $remaining -= $row + 1;
    }
    for ($i = 1; $i <= $concurrency; $i++) {
        $operations[] = ['parent' => 'master:' . $i, 'new' => 'review:' . $i, 'direction' => 'right', 'size' => $right];
        $operations[] = ['parent' => 'review:' . $i, 'new' => 'fix:' . $i, 'direction' => 'down', 'size' => $slots['fix:' . $i]['height']];
    }
    return ['version' => 1, 'concurrency' => $concurrency, 'area' => $area, 'slots' => $slots, 'operations' => $operations];
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
