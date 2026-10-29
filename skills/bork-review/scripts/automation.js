'use strict';

const c = require("./support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };

/** Reduce assessed scoped evidence into a conservative completion event. */
function automationEvent(state, scope, now) {
  c.assertType(state, "array", "automationEvent.state");
  c.assertType(scope, "array", "automationEvent.scope");
  c.assertType(now, "int", "automationEvent.now");
  let activity, assessment, failed, hasBot, id, pending, quiet, requirement, signal, signalStarted, started, status;
  scope = c.clone(scope);
  now = c.clone(now);
  assessment = c.clone(c.get(state, "assessment") ?? null);
  if (!c.is_array(assessment) || !c.equal(c.get(assessment, "evidence_hash") ?? "", c.get(state, "evidence_hash") ?? null)) {
    return c.entriesArray([["event", "changed"], ["reason", "assessment_required"]]);
  }
  if (!c.equal(c.get(assessment, "head") ?? "", require("./workflow.js").value(scope, "head"))) {
    throw new Error("Automation HEAD changed; reconcile scope.");
  }
  if (!c.is_bool(c.get(assessment, "draft") ?? null)) {
    throw new Error("Fresh draft state is required.");
  }
  if (c.truth(c.get(assessment, "draft"))) {
    return c.entriesArray([["event", "skipped_draft"]]);
  }
  pending = c.clone([]);
  failed = c.clone([]);
  started = c.clone(c.equal(c.get(state, "review_started") ?? false, true));
  hasBot = false;
  for (const [_key, _value] of c.entries(c.get(scope, "signals"))) {
    requirement = c.clone(_value);
    {
      hasBot = c.clone(c.truth(hasBot) || !c.equal(c.get(requirement, "kind"), "check"));
    }
  }
  quiet = c.clone(!c.truth(hasBot));
  for (const [_key, _value] of c.entries(c.get(scope, "signals"))) {
    id = _key;
    requirement = c.clone(_value);
    {
      signal = c.clone(c.get(assessment, "signals", id) ?? null);
      if (c.equal(signal, null)) {
        c.append(pending, [], id);
        continue;
      }
      if (!c.equal(c.get(signal, "head") ?? "", c.get(scope, "head")) || !c.truth(c.get(signal, "evidence"))) {
        throw new Error(c.string("Signal lacks SHA-correlated evidence: ") + c.string(id));
      }
      if (c.equal(c.get(scope, "mode") ?? "", "promotion") && !c.equal(c.get(signal, "event_id") ?? "", require("./workflow.js").value(scope, "event_id"))) {
        throw new Error("Signal is not correlated with this ready event.");
      }
      status = c.clone(c.get(signal, "status") ?? "");
      if (!c.in_array(status, ["missing", "pending", "terminal", "blocked"], true)) {
        throw new Error("Invalid signal status.");
      }
      if (c.equal(status, "blocked")) {
        throw new Error(c.string("Scoped automation is blocked: ") + c.string(id));
      }
      signalStarted = c.clone(c.equal(c.get(signal, "started") ?? false, true) || c.equal(c.get(requirement, "kind"), "review") && c.equal(status, "terminal") && c.equal(c.get(signal, "completed_review") ?? false, true));
      if (c.equal(c.get(scope, "mode"), "promotion") && c.truth(signalStarted) && !c.truth(started)) {
        if (!c.is_int(c.get(signal, "started_at") ?? null) || c.get(signal, "started_at") > now || c.get(signal, "started_at") > c.add(c.get(scope, "promotion_time"), 600)) {
          throw new Error("Review start time is missing or outside the promotion startup deadline.");
        }
      }
      started = c.clone(c.truth(started) || c.truth(signalStarted));
      if (!c.equal(status, "terminal")) {
        c.append(pending, [], id);
      } else if (c.equal(c.get(requirement, "kind"), "review") && !c.equal(c.get(signal, "completed_review") ?? false, true)) {
        throw new Error("Explicit review completion evidence is missing.");
      }
      if (c.equal(c.get(requirement, "kind"), "quiet_review")) {
        quiet = true;
      }
      if (c.equal(c.get(signal, "failed") ?? false, true)) {
        if (!c.equal(c.get(requirement, "kind"), "check")) {
          throw new Error("Review automation failed without a completed review.");
        }
        c.append(failed, [], id);
      }
    }
  }
  c.set(state, ["review_started"], "=", started);
  if (c.equal(c.get(scope, "mode") ?? "", "promotion") && !c.truth(started) && now >= c.add(c.integer(c.get(scope, "promotion_time")), 600)) {
    throw new Error("No correlated review started within ten minutes of promotion.");
  }
  activity = c.clone(require("./workflow.js").value(assessment, "activity_hash"));
  if (!c.equal(c.get(state, "activity_hash") ?? "", activity)) {
    c.set(state, ["activity_hash"], "=", activity);
    c.set(state, ["quiet_since"], "=", now);
  }
  if (c.truth(pending)) {
    /* Start the quiet interval only after all required signals are terminal. */
    c.set(state, ["quiet_since"], "=", now);
    return c.entriesArray([["event", "waiting"], ["pending", pending]]);
  }
  if (c.truth(quiet) && now - (c.get(state, "quiet_since") ?? now) < 120) {
    return c.entriesArray([["event", "waiting"], ["quiet_remaining", 120 - (now - c.get(state, "quiet_since"))]]);
  }
  return c.entriesArray([["event", "complete"], ["failed_checks", failed]]);
}
/** Load and validate immutable polling scope and its saved state. */
function automationContext(input) {
  c.assertType(input, "array", "automationContext.input");
  let scope, signal, state;
  input = c.clone(input);
  scope = c.clone(require("./workflow.js").readJson(require("./workflow.js").value(input, "scope")));
  require("./workflow.js").value(scope, "head");
  if (!c.in_array(c.get(scope, "mode") ?? "", ["follow_up", "promotion"], true) || !c.is_array(c.get(scope, "sources") ?? null) || !c.truth(c.get(scope, "sources")) || !c.is_array(c.get(scope, "signals") ?? null)) {
    throw new Error("Incomplete automation scope.");
  }
  for (const [_key, _value] of c.entries(c.get(scope, "signals"))) {
    signal = c.clone(_value);
    {
      if (!c.is_array(signal) || !c.in_array(c.get(signal, "kind") ?? "", ["check", "review", "quiet_review"], true)) {
        throw new Error("Invalid automation requirement.");
      }
    }
  }
  if (c.equal(c.get(scope, "mode"), "promotion")) {
    require("./workflow.js").value(scope, "event_id");
    if (!c.is_int(c.get(scope, "promotion_time") ?? null) || !c.equal(c.count(c.get(scope, "signals")), 1) || !c.equal(c.get(c.reset(c.get(scope, "signals")), "kind"), "review")) {
      throw new Error("Promotion requires one explicit reviewer and a saved promotion time.");
    }
  }
  state = c.clone(c.file_exists(require("./workflow.js").value(input, "state")) ? require("./workflow.js").readJson(c.get(input, "state")) : []);
  if (c.truth(state) && !c.equal(c.get(state, "scope_hash") ?? "", require("./evidence.js").evidenceHash(scope))) {
    throw new Error("Automation scope changed; start a reconciled scope.");
  }
  c.set(state, ["scope_hash"], "=", require("./evidence.js").evidenceHash(scope));
  return [scope, state];
}
/** Poll complete snapshots once, reusing assessments only for identical evidence. */
function automationPoll(input) {
  c.assertType(input, "array", "automationPoll.input");
  let changes, deadline, hashes, id, remaining, request, result, scope, snapshots, spec, state;
  input = c.clone(input);
  [scope, state] = c.clone(automationContext(input));
  deadline = c.clone(c.add(c.microtime(true), 45));
  snapshots = c.clone([]);
  hashes = c.clone([]);
  changes = c.clone([]);
  for (const [_key, _value] of c.entries(c.get(scope, "sources"))) {
    id = _key;
    spec = c.clone(_value);
    {
      remaining = c.clone(c.integer(c.floor(deadline - c.microtime(true))));
      if (remaining < 1) {
        throw new Error("Poll exceeded its bounded budget; retain prior state.");
      }
      request = c.clone(c.entriesArray([["spec", spec], ["path", c.string(c.string(c.string(require("./workflow.js").value(input, "directory")) + c.string("/snapshot-")) + c.string(c.bin2hex(c.random_bytes(8)))) + c.string(".json")], ["seconds", c.min(20, remaining)]]));
      if (c.get(state, "snapshots", id) != null) {
        c.set(request, ["previous"], "=", c.get(state, "snapshots", id));
      }
      result = c.clone(require("./evidence.js").snapshot(request));
      c.set(snapshots, [id], "=", c.get(result, "path"));
      c.set(hashes, [id], "=", c.get(result, "hash"));
      if (c.equal(c.get(result, "event"), "changed")) {
        c.set(changes, [id], "=", result);
      }
    }
  }
  if (c.get(state, "polled_at") != null && c.time() - c.get(state, "polled_at") > 60) {
    c.set(state, ["quiet_since"], "=", c.time());
  }
  c.set(state, ["snapshots"], "=", snapshots);
  c.set(state, ["evidence_hash"], "=", require("./evidence.js").evidenceHash(hashes));
  c.set(state, ["polled_at"], "=", c.time());
  result = c.clone(automationEvent(state, scope, c.time()));
  require("./workflow.js").atomicWrite(require("./workflow.js").value(input, "state"), c.json_encode(state, c.JSON_UNESCAPED_SLASHES | c.JSON_THROW_ON_ERROR));
  return c.add(result, c.entriesArray([["state", c.get(input, "state")], ["evidence_hash", c.get(state, "evidence_hash")], ["changes", c.object(changes)]]));
}
/** Save a scoped semantic assessment against exactly the last complete poll. */
function automationAssess(input) {
  c.assertType(input, "array", "automationAssess.input");
  let assessment, result, scope, state;
  input = c.clone(input);
  [scope, state] = c.clone(automationContext(input));
  assessment = c.clone(require("./workflow.js").readJson(require("./workflow.js").value(input, "assessment")));
  if (!c.truth(c.get(state, "evidence_hash")) || !c.equal(c.get(assessment, "evidence_hash") ?? "", c.get(state, "evidence_hash")) || c.time() - (c.get(state, "polled_at") ?? 0) > 60) {
    throw new Error("Assessment is stale; poll again before recording it.");
  }
  c.set(state, ["assessment"], "=", assessment);
  result = c.clone(automationEvent(state, scope, c.time()));
  require("./workflow.js").atomicWrite(require("./workflow.js").value(input, "state"), c.json_encode(state, c.JSON_UNESCAPED_SLASHES | c.JSON_THROW_ON_ERROR));
  return c.add(result, c.entriesArray([["state", c.get(input, "state")]]));
}
module.exports = {
  automationEvent,
  automationContext,
  automationPoll,
  automationAssess
};
