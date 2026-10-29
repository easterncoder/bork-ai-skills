'use strict';

const c = require("../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };

/** Mark queued targets whose prerequisites are already blocked. */
function propagateBlocked(targets, blocked) {
  c.assertType(targets, "array", "propagateBlocked.targets");
  c.assertType(blocked, "array", "propagateBlocked.blocked");
  let changed, id, parent, target;
  targets = c.clone(targets);
  do {
    changed = false;
    for (const [_key, _value] of c.entries(targets)) {
      id = _key;
      target = c.clone(_value);
      {
        if (!c.equal(c.get(target, "status"), "queued") || c.get(blocked, id) != null) {
          continue;
        }
        for (const [_key, _value] of c.entries(c.get(target, "depends_on"))) {
          parent = c.clone(_value);
          {
            if (c.in_array(c.get(targets, parent, "status"), ["blocked", "skipped"], true) || c.get(blocked, parent) != null) {
              c.set(blocked, [id], "=", c.entriesArray([["reason", "dependency_blocked"], ["dependency", parent]]));
              changed = true;
              break;
            }
          }
        }
      }
    }
  } while (c.truth(changed));
}
/** Find queued nodes in a dependency cycle without changing target state. */
function visitCycles(id, targets, state, stack, blocked) {
  c.assertType(id, "string", "visitCycles.id");
  c.assertType(targets, "array", "visitCycles.targets");
  c.assertType(state, "array", "visitCycles.state");
  c.assertType(stack, "array", "visitCycles.stack");
  c.assertType(blocked, "array", "visitCycles.blocked");
  let cycle, member, parent;
  id = c.clone(id);
  targets = c.clone(targets);
  c.set(state, [id], "=", 1);
  c.append(stack, [], id);
  for (const [_key, _value] of c.entries(c.get(targets, id, "depends_on"))) {
    parent = c.clone(_value);
    {
      if (!c.equal(c.get(targets, parent, "status"), "queued") || c.get(blocked, parent) != null) {
        continue;
      }
      if (!(c.get(state, parent) != null)) {
        visitCycles(parent, targets, state, stack, blocked);
      } else if (c.equal(c.get(state, parent), 1)) {
        cycle = c.clone(c.array_slice(stack, c.array_search(parent, stack, true)));
        for (const [_key, _value] of c.entries(cycle)) {
          member = c.clone(_value);
          {
            c.set(blocked, [member], "=", c.entriesArray([["reason", "dependency_cycle"], ["cycle", cycle]]));
          }
        }
      }
    }
  }
  c.array_pop(stack);
  c.set(state, [id], "=", 2);
}
/** Return dependency-ready targets and explicit blocked queue entries. */
function schedule(data) {
  c.assertType(data, "array", "schedule.data");
  let active, blocked, id, limit, parent, ready, satisfied, stack, state, target, targets, waiting;
  data = c.clone(data);
  limit = c.clone(c.get(data, "max_concurrency") ?? 1);
  if (!c.is_int(limit) || limit < 1 || limit > 3) {
    throw new Error("max_concurrency must be an integer from one to three.");
  }
  targets = c.clone(c.get(data, "targets") ?? null);
  if (!c.is_array(targets)) {
    throw new Error("Missing target map.");
  }
  active = 0;
  for (const [_key, _value] of c.entries(targets)) {
    id = _key;
    target = c.clone(_value);
    {
      if (!c.is_array(target) || !c.in_array(c.get(target, "status") ?? "", ["queued", "starting", "running", "waiting_review", "complete", "blocked", "skipped"], true)) {
        throw new Error("Invalid target state.");
      }
      if (c.in_array(c.get(target, "status"), ["starting", "running", "waiting_review"], true)) {
        active = c.add(active, 1);
      }
      if (!c.is_array(c.get(target, "depends_on") ?? null)) {
        throw new Error("Missing dependencies.");
      }
      for (const [_key, _value] of c.entries(c.get(target, "depends_on"))) {
        parent = c.clone(_value);
        {
          if (!c.is_string(parent) || !(c.get(targets, parent) != null) || c.equal(c.string(id), parent)) {
            throw new Error("Invalid or unresolved dependency.");
          }
        }
      }
    }
  }
  blocked = c.clone([]);
  propagateBlocked(targets, blocked);
  state = c.clone([]);
  stack = c.clone([]);
  for (const [_key, _value] of c.entries(targets)) {
    id = _key;
    target = c.clone(_value);
    {
      if (c.equal(c.get(target, "status"), "queued") && !(c.get(blocked, id) != null) && !(c.get(state, id) != null)) {
        visitCycles(c.string(id), targets, state, stack, blocked);
      }
    }
  }
  propagateBlocked(targets, blocked);
  ready = c.clone([]);
  waiting = c.clone([]);
  for (const [_key, _value] of c.entries(targets)) {
    id = _key;
    target = c.clone(_value);
    {
      if (!c.equal(c.get(target, "status"), "queued") || c.get(blocked, id) != null) {
        continue;
      }
      satisfied = true;
      for (const [_key, _value] of c.entries(c.get(target, "depends_on"))) {
        parent = c.clone(_value);
        {
          if (!c.equal(c.get(targets, parent, "status"), "complete")) {
            satisfied = false;
          }
        }
      }
      if (c.truth(satisfied) && c.count(ready) < limit - active) {
        c.append(ready, [], c.string(id));
      } else {
        c.append(waiting, [], c.string(id));
      }
    }
  }
  return c.entriesArray([["active", active], ["launch", ready], ["waiting", waiting], ["blocked", c.object(blocked)]]);
}
module.exports = {
  propagateBlocked,
  visitCycles,
  schedule
};
