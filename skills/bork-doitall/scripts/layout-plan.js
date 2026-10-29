'use strict';

const c = require("../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };

/** Plan stable role slots inside the coordinator's original rectangle. */
function borkLayoutPlan(concurrency, area, gap = 1) {
  c.assertType(concurrency, "int", "borkLayoutPlan.concurrency");
  c.assertType(area, "array", "borkLayoutPlan.area");
  c.assertType(gap, "int", "borkLayoutPlan.gap");
  let height, i, key, left, master, operations, remaining, review, right, row, slots, workers, y;
  concurrency = c.clone(concurrency);
  area = c.clone(area);
  gap = c.clone(gap);
  if (!c.in_array(gap, [0, 1], true)) {
    throw new Error("Layout separator must be zero or one cell.");
  }
  if (concurrency < 1 || concurrency > 3) {
    throw new Error("Layout concurrency must be 1, 2 or 3.");
  }
  for (const [_key, _value] of c.entries(["x", "y", "width", "height"])) {
    key = c.clone(_value);
    {
      if (!(c.get(area, key) != null) || !c.is_int(c.get(area, key)) || c.get(area, key) < (c.equal(key, "width") || c.equal(key, "height") ? 1 : 0)) {
        throw new Error("Layout needs verified integer pane geometry.");
      }
    }
  }
  left = c.clone(c.max(20, c.integer(c.floor((c.get(area, "width") - 2 * gap) * 0.22))));
  workers = c.clone(c.get(area, "width") - left - gap);
  master = c.clone(c.intdiv(workers - gap, 2));
  right = c.clone(workers - master - gap);
  height = c.clone(c.intdiv(c.get(area, "height") - (concurrency - 1) * gap, concurrency));
  if (master < 35 || right < 35 || height < 13) {
    throw new Error("Insufficient space for the tree: each worker needs 35 columns and 6 rows; each group needs 13 rows. Resize the coordinator area; no alternate topology will be used.");
  }
  slots = c.clone(c.entriesArray([["coordinator", c.array_replace(area, c.entriesArray([["width", left]]))]]));
  operations = c.clone([c.entriesArray([["parent", "coordinator"], ["new", "master:1"], ["direction", "right"], ["size", workers]])]);
  y = c.clone(c.get(area, "y"));
  remaining = c.clone(c.get(area, "height"));
  for (i = 1; i <= concurrency; i = c.add(i, 1)) {
    row = c.clone(c.equal(i, concurrency) ? remaining : height);
    if (i < concurrency) {
      c.append(operations, [], c.entriesArray([["parent", c.string("master:") + c.string(i)], ["new", c.string("master:") + c.string(c.add(i, 1))], ["direction", "down"], ["size", remaining - row - gap]]));
    }
    c.set(slots, [c.string("master:") + c.string(i)], "=", c.entriesArray([["x", c.add(c.add(c.get(area, "x"), left), gap)], ["y", y], ["width", master], ["height", row]]));
    review = c.clone(c.intdiv(row - gap, 2));
    c.set(slots, [c.string("review:") + c.string(i)], "=", c.entriesArray([["x", c.add(c.add(c.add(c.get(area, "x"), left), master), 2 * gap)], ["y", y], ["width", right], ["height", review]]));
    c.set(slots, [c.string("fix:") + c.string(i)], "=", c.array_replace(c.get(slots, c.string("review:") + c.string(i)), c.entriesArray([["y", c.add(c.add(y, review), gap)], ["height", row - review - gap]])));
    y = c.add(y, c.add(row, gap));
    remaining -= c.add(row, gap);
  }
  for (i = 1; i <= concurrency; i = c.add(i, 1)) {
    c.append(operations, [], c.entriesArray([["parent", c.string("master:") + c.string(i)], ["new", c.string("review:") + c.string(i)], ["direction", "right"], ["size", right]]));
    c.append(operations, [], c.entriesArray([["parent", c.string("review:") + c.string(i)], ["new", c.string("fix:") + c.string(i)], ["direction", "down"], ["size", c.get(slots, c.string("fix:") + c.string(i), "height")]]));
  }
  return c.entriesArray([["version", 1], ["concurrency", concurrency], ["area", area], ["separator", gap], ["slots", slots], ["operations", operations]]);
}
/** Reject geometry drift before assigning or replacing a worker. */
function borkLayoutGeometry(expected, actual, tolerance = 0) {
  c.assertType(expected, "array", "borkLayoutGeometry.expected");
  c.assertType(actual, "array", "borkLayoutGeometry.actual");
  c.assertType(tolerance, "int", "borkLayoutGeometry.tolerance");
  let key;
  expected = c.clone(expected);
  actual = c.clone(actual);
  tolerance = c.clone(tolerance);
  for (const [_key, _value] of c.entries(["x", "y", "width", "height"])) {
    key = c.clone(_value);
    {
      if (!(c.get(actual, key) != null) || !c.is_int(c.get(actual, key)) || c.abs(c.get(expected, key) - c.get(actual, key)) > tolerance) {
        throw new Error("Layout geometry changed; reconcile resize or user edits before further launches.");
      }
    }
  }
}
module.exports = {
  borkLayoutPlan,
  borkLayoutGeometry
};
