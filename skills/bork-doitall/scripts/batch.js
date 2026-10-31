'use strict';

const c = require("../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };
let error, input, inputPath, result;

/** Require a nonempty string from a JSON object. */
function requiredText(data, key) {
  c.assertType(data, "array", "requiredText.data");
  c.assertType(key, "string", "requiredText.key");
  data = c.clone(data);
  key = c.clone(key);
  if (!(c.get(data, key) != null) || !c.is_string(c.get(data, key)) || c.equal(c.get(data, key), "")) {
    throw new Error(c.string("Missing string: ") + c.string(key));
  }
  return c.get(data, key);
}
/** Read current or legacy selected-reviewer gate evidence. */
function reviewerGateRecord(target) {
  c.assertType(target, "array", "reviewerGateRecord.target");
  target = c.clone(target);
  return c.get(target, "phase_records", "reviewer_gate") ?? c.get(target, "phase_records", "cspf") ?? null;
}
/** Validate a supplied profile against its approved content hash. */
function validateReviewProfile(plan) {
  c.assertType(plan, "array", "validateReviewProfile.plan");
  let hash, profile;
  plan = c.clone(plan);
  profile = c.clone(requiredText(plan, "review_profile"));
  if (c.equal(profile, "generic")) {
    return;
  }
  if (!c.equal(c.get(profile, 0), "/") || c.is_link(profile) || !c.is_file(profile) || !c.is_readable(profile)) {
    throw new Error("Review profile must be generic or an absolute readable regular file.");
  }
  hash = c.clone(requiredText(plan, "review_profile_sha256"));
  if (!c.truth(c.preg_match("/^[a-f0-9]{64}$/", hash)) || !c.truth(c.hash_equals(hash, c.hash_file("sha256", profile)))) {
    throw new Error("Review profile does not match its approved hash.");
  }
}
/** Read a regular JSON object without following a symbolic link. */
function jsonFile(path) {
  c.assertType(path, "string", "jsonFile.path");
  let value;
  path = c.clone(path);
  if (c.is_link(path) || !c.is_file(path)) {
    throw new Error("Expected regular JSON file.");
  }
  value = c.clone(c.json_decode(c.file_get_contents(path), true, 512, c.JSON_THROW_ON_ERROR));
  if (!c.is_array(value) || c.array_is_list(value)) {
    throw new Error("Expected JSON object.");
  }
  return value;
}
/** Replace a record atomically in its existing directory. */
function publishJson(path, value) {
  c.assertType(path, "string", "publishJson.path");
  c.assertType(value, "array", "publishJson.value");
  c.atomicWrite(path, c.json_encode(value, c.JSON_PRETTY_PRINT) + '\n', '.batch-');
}

/** Hold a local batch mutex while reading and replacing the plan. */
function lockedPlan(path, change) {
  c.assertType(path, "string", "lockedPlan.path");
  c.assertType(change, "callable", "lockedPlan.change");
  change = c.callable(change);
  change = c.callable(change);
  const plan = c.is_file(path) ? jsonFile(path) : null;
  const [updated, result] = change(plan);
  if (updated !== null) publishJson(path, updated);
  return result;
}

/** Check the recorded approval against the exact displayed preview. */
function approved(plan) {
  c.assertType(plan, "array", "approved.plan");
  let approval, preview;
  plan = c.clone(plan);
  preview = c.clone(requiredText(plan, "approved_preview"));
  approval = c.clone(c.get(plan, "approval_evidence") ?? null);
  if (!c.is_array(approval) || !c.equal(c.get(approval, "response") ?? null, "go") || !c.equal(c.get(approval, "preview_sha256") ?? null, c.hash("sha256", preview))) {
    throw new Error("Approved preview and go evidence are required.");
  }
  require("./environment.js").validateEnvironmentSelection(plan);
  if (!c.equal(c.get(plan, "schema_version") ?? null, 5) || !c.is_array(c.get(plan, "targets") ?? null)) {
    throw new Error("Expected a version 5 target plan.");
  }
}
/** Require a target in an expected queue state. */
function targetAt(plan, id, states) {
  c.assertType(plan, "array", "targetAt.plan");
  c.assertType(id, "string", "targetAt.id");
  c.assertType(states, "array", "targetAt.states");
  let target;
  plan = c.clone(plan);
  id = c.clone(id);
  states = c.clone(states);
  target = c.clone(c.get(plan, "targets", id) ?? null);
  if (!c.is_array(target) || !c.in_array(c.get(target, "status") ?? null, states, true)) {
    throw new Error("Target missing or in the wrong state.");
  }
  return target;
}
/** Verify an observed PR and exact published head. */
function observedHead(input, pr, head) {
  c.assertType(input, "array", "observedHead.input");
  c.assertType(pr, "string", "observedHead.pr");
  c.assertType(head, "string", "observedHead.head");
  let remote;
  input = c.clone(input);
  pr = c.clone(pr);
  head = c.clone(head);
  remote = c.clone(c.get(input, "remote") ?? null);
  if (!c.is_array(remote) || !c.equal(c.get(remote, "pr_url") ?? null, pr) || !c.equal(c.get(remote, "head") ?? null, head)) {
    throw new Error("Remote PR or head does not match recorded intent.");
  }
}
/** Resolve a fresh ready-entry head or retain the published phase head. */
function completionHead(input, target) {
  c.assertType(input, "array", "completionHead.input");
  c.assertType(target, "array", "completionHead.target");
  if (c.equal(c.get(target, "entry_phase") ?? null, "ready") && c.equal(c.count(c.get(target, "phase_records") ?? []), 0) && c.equal(c.count(c.get(target, "mutations") ?? []), 0)) {
    const remote = c.get(input, "remote") ?? null;
    if (!c.is_array(remote) || !c.equal(c.get(remote, "state") ?? null, "OPEN") || !c.equal(c.get(remote, "is_draft") ?? null, false)) {
      throw new Error("Ready entry requires fresh open, ready PR evidence.");
    }
    return requiredText(remote, "head");
  }
  return requiredText(target, "published_head");
}
/** Accept a completed child result from the original path, including after master loss. */
function adoptChild(plan, input) {
  c.assertType(plan, "array", "adoptChild.plan");
  c.assertType(input, "array", "adoptChild.input");
  let head, id, phase, pr, record, result, target;
  input = c.clone(input);
  id = c.clone(requiredText(input, "target_id"));
  phase = c.clone(requiredText(input, "phase"));
  if (!c.in_array(phase, ["prify", "draft_goodcode", "ready_goodcode"], true)) {
    throw new Error("Invalid child phase.");
  }
  target = c.clone(targetAt(plan, id, ["running", "waiting_review"]));
  record = c.clone(c.get(target, "phase_records", phase) ?? null);
  if (!c.is_array(record) || !c.equal(c.get(record, "status") ?? null, "pending")) {
    throw new Error("No pending child phase to adopt.");
  }
  result = c.clone(jsonFile(requiredText(record, "result_path")));
  if (!c.equal(c.get(result, "phase") ?? null, phase) || !c.equal(c.get(result, "status") ?? null, "complete")) {
    throw new Error("Child result is missing or incomplete.");
  }
  pr = c.clone(requiredText(result, "pr_url"));
  head = c.clone(requiredText(result, "published_head"));
  if (c.get(record, "pr_url") != null && !c.equal(c.get(record, "pr_url"), pr)) {
    throw new Error("Child PR differs from the phase intent.");
  }
  /* Goodcode may advance the head by pushing fixes; reviewed_head and the live remote are verified below. */
  if (c.equal(phase, "prify") && c.get(record, "expected_head") != null && !c.equal(c.get(record, "expected_head"), head)) {
    throw new Error("Child head differs from the phase intent.");
  }
  if (!c.equal(c.get(result, "cleanup_success") ?? null, true) || !c.equal(c.get(input, "agent_stopped") ?? null, true) || !c.equal(c.get(input, "descendants_stopped") ?? null, true)) {
    throw new Error("Child or cleanup is not confirmed complete.");
  }
  observedHead(input, pr, head);
  if (!c.equal(phase, "prify") && (!c.equal(c.get(result, "workers_stopped") ?? null, true) || !c.equal(c.get(result, "reviewed_head") ?? null, head))) {
    throw new Error("Goodcode review or worker evidence is incomplete.");
  }
  c.set(record, ["status"], "=", "complete");
  c.set(record, ["pr_url"], "=", pr);
  c.set(record, ["published_head"], "=", head);
  c.set(record, ["completed_at"], "=", c.gmdate("c"));
  c.set(target, ["phase_records", phase], "=", record);
  c.set(target, ["pr_url"], "=", pr);
  c.set(target, ["published_head"], "=", head);
  c.set(plan, ["targets", id], "=", target);
  return c.entriesArray([["event", "phase_complete"], ["target_id", id], ["phase", phase], ["head", head]]);
}
/** Return the next safe action for a target without inferring remote facts. */
function inspectTarget(plan, id) {
  c.assertType(plan, "array", "inspectTarget.plan");
  c.assertType(id, "string", "inspectTarget.id");
  let kind, mutation, phase, record, target;
  plan = c.clone(plan);
  id = c.clone(id);
  target = c.clone(targetAt(plan, id, ["queued", "starting", "running", "waiting_review", "complete", "blocked", "skipped"]));
  for (const [_key, _value] of c.entries(c.get(target, "mutations") ?? [])) {
    kind = _key;
    mutation = c.clone(_value);
    {
      if (c.equal(c.get(mutation, "status") ?? null, "pending")) {
        return c.entriesArray([["event", "reconcile_mutation"], ["kind", kind], ["intent", mutation]]);
      }
    }
  }
  for (const [_key, _value] of c.entries(c.get(target, "phase_records") ?? [])) {
    phase = _key;
    record = c.clone(_value);
    {
      if (c.equal(c.get(record, "status") ?? null, "pending")) {
        return c.entriesArray([["event", "reconcile_phase"], ["phase", phase], ["result_path", c.get(record, "result_path")]]);
      }
    }
  }
  return c.entriesArray([["event", "state"], ["status", c.get(target, "status")]]);
}
/** Resume one blocked target without replacing approval, phase or mutation evidence. */
function resumeTarget(plan, input) {
  c.assertType(plan, "array", "resumeTarget.plan");
  c.assertType(input, "array", "resumeTarget.input");
  let agent, dependency, evidence, evidencePath, flag, head, id, mutation, pr, prior, target;
  input = c.clone(input);
  id = c.clone(requiredText(input, "target_id"));
  target = c.clone(targetAt(plan, id, ["blocked"]));
  evidencePath = c.clone(requiredText(input, "evidence_path"));
  evidence = c.clone(jsonFile(evidencePath));
  for (const [_key, _value] of c.entries(["user_continuation", "scope_unchanged", "prior_master_stopped", "children_reconciled"])) {
    flag = c.clone(_value);
    {
      if (!c.equal(c.get(evidence, flag) ?? null, true)) {
        throw new Error(c.string("Resume evidence missing: ") + c.string(flag));
      }
    }
  }
  requiredText(evidence, "user_instruction");
  agent = c.clone(requiredText(input, "agent_id"));
  if (!c.equal(c.get(evidence, "batch_id") ?? null, c.get(plan, "batch_id")) || !c.equal(c.get(evidence, "target_id") ?? null, id) || !c.equal(c.get(evidence, "approved_preview_sha256") ?? null, c.hash("sha256", c.get(plan, "approved_preview"))) || !c.equal(c.get(evidence, "prior_master_agent_id") ?? null, c.get(target, "master_agent_id") ?? null) || !c.equal(c.get(evidence, "recovered_master_agent_id") ?? null, agent)) {
    throw new Error("Resume identity or approval differs from the blocked target.");
  }
  for (const [_key, _value] of c.entries(c.get(target, "mutations") ?? [])) {
    mutation = c.clone(_value);
    {
      if (c.equal(c.get(mutation, "status") ?? null, "pending")) {
        throw new Error("Reconcile uncertain mutations before resuming a target.");
      }
    }
  }
  for (const [_key, _value] of c.entries(c.get(target, "depends_on"))) {
    dependency = c.clone(_value);
    {
      if (!c.equal(c.get(plan, "targets", dependency, "status"), "complete")) {
        throw new Error("Resume dependency is not complete.");
      }
    }
  }
  if (c.get(require("./scheduler.js").schedule(plan), "active") >= c.get(plan, "max_concurrency")) {
    throw new Error("No concurrency slot is available for resume.");
  }
  pr = c.clone(c.get(target, "pr_url") ?? null);
  head = c.clone(c.get(target, "published_head") ?? null);
  if (c.equal(pr, null) && c.get(target, "phase_records", "prify", "result_path") != null && c.is_file(c.get(target, "phase_records", "prify", "result_path"))) {
    prior = c.clone(jsonFile(c.get(target, "phase_records", "prify", "result_path")));
    pr = c.clone(c.get(prior, "pr_url") ?? null);
    head = c.clone(c.get(prior, "published_head") ?? null);
  }
  if (!c.equal(pr, null)) {
    observedHead(input, pr, head);
    if (!c.equal(c.get(input, "remote", "state") ?? null, "OPEN") || !c.equal(c.get(input, "remote", "is_draft") ?? null, true) || !c.equal(c.get(evidence, "remote") ?? null, c.get(input, "remote"))) {
      throw new Error("Resume requires matching fresh open-draft PR evidence.");
    }
  }
  c.append(target, ["resume_history"], c.entriesArray([["blocker", c.get(target, "blocker") ?? null], ["prior_master_agent_id", c.get(target, "master_agent_id") ?? null], ["master_agent_id", agent], ["evidence_path", evidencePath], ["evidence_sha256", c.hash_file("sha256", evidencePath)], ["resumed_at", c.gmdate("c")]]));
  c.set(target, ["status"], "=", "running");
  c.set(target, ["master_agent_id"], "=", agent);
  c.set(plan, ["targets", id], "=", target);
  return c.entriesArray([["event", "target_resumed"], ["target_id", id]]);
}
/** Apply one checked transition to the approved plan. */
function changePlan(plan, input) {
  c.assertType(plan, "?array", "changePlan.plan");
  c.assertType(input, "array", "changePlan.input");
  let action, evidence, evidencePath, field, head, id, intent, kind, newValue, path, phase, pr, reason, record, remote, report, result, reviewer, selection, skipReady, target;
  plan = c.clone(plan);
  input = c.clone(input);
  action = c.clone(requiredText(input, "action"));
  if (c.equal(action, "init")) {
    if (!c.equal(plan, null)) {
      throw new Error("Batch already exists; reconcile it.");
    }
    newValue = c.clone(c.get(input, "plan") ?? null);
    if (!c.is_array(newValue)) {
      throw new Error("Missing approved plan.");
    }
    c.set(newValue, ["reviewer"], "=", c.get(newValue, "reviewer") ?? "NONE");
    reviewer = c.clone(requiredText(newValue, "reviewer"));
    skipReady = c.clone(c.equal(reviewer, "NONE"));
    if (c.get(newValue, "skip_ready_goodcode") != null && !c.equal(c.get(newValue, "skip_ready_goodcode"), skipReady)) {
      throw new Error("Reviewer and ready-goodcode skip disagree.");
    }
    c.set(newValue, ["skip_ready_goodcode"], "=", skipReady);
    c.set(newValue, ["review_profile"], "=", c.get(newValue, "review_profile") ?? "generic");
    validateReviewProfile(newValue);
    if (c.get(newValue, "effort_override") != null && !c.in_array(c.get(newValue, "effort_override"), ["low", "standard", "high"], true)) {
      throw new Error("Effort override must be low, standard or high.");
    }
    approved(newValue);
    require("./scheduler.js").schedule(newValue);
    c.set(newValue, ["state_revision"], "=", 0);
    return [newValue, c.entriesArray([["event", "initialized"]])];
  }
  if (c.equal(plan, null)) {
    throw new Error("Batch plan missing.");
  }
  approved(plan);
  if (c.equal(action, "inspect")) {
    return [null, inspectTarget(plan, requiredText(input, "target_id"))];
  }
  if (!c.equal(c.get(input, "expected_revision") ?? null, c.get(plan, "state_revision") ?? 0)) {
    throw new Error("Plan revision changed; inspect before retrying.");
  }
  if (c.equal(action, "reserve")) {
    selection = c.clone(require("./scheduler.js").schedule(plan));
    if (plan.layout_record) {
      const layout = require('./terminal.js').readInput(plan.layout_record);
      if (layout.version === 2) {
        const admitted = [];
        selection.waiting_capacity = {};
        for (const targetId of selection.launch) {
          const target = plan.targets[targetId];
          const capacity = require('./layout.js').borkLayoutAction('admit', {record: plan.layout_record, target_id: targetId, ...(target.slot ? {slot: target.slot} : {})});
          target.capacity = capacity;
          if (capacity.admitted) { target.slot = capacity.slot; admitted.push(targetId); }
          else if (capacity.status === 'blocked') c.set(selection, ['blocked', targetId], '=', capacity.reason);
          else selection.waiting_capacity[targetId] = capacity;
        }
        selection.launch = admitted;
      }
    }
    for (const [_key, _value] of c.entries(c.get(selection, "blocked"))) {
      id = _key;
      reason = c.clone(_value);
      {
        c.set(plan, ["targets", id, "status"], "=", "blocked");
        c.set(plan, ["targets", id, "blocker"], "=", reason);
      }
    }
    for (const [_key, _value] of c.entries(c.get(selection, "launch"))) {
      id = c.clone(_value);
      {
        c.set(plan, ["targets", id, "status"], "=", "starting");
      }
    }
    result = c.clone(c.entriesArray([["event", "reserved"], ["launch", c.get(selection, "launch")], ["blocked", c.get(selection, "blocked")], ["waiting_capacity", selection.waiting_capacity ?? {}]]));
  } else if (c.equal(action, "started")) {
    id = c.clone(requiredText(input, "target_id"));
    targetAt(plan, id, ["starting"]);
    c.set(plan, ["targets", id, "master_agent_id"], "=", requiredText(input, "agent_id"));
    c.set(plan, ["targets", id, "status"], "=", "running");
    result = c.clone(c.entriesArray([["event", "running"], ["target_id", id]]));
  } else if (c.equal(action, "phase-start")) {
    id = c.clone(requiredText(input, "target_id"));
    phase = c.clone(requiredText(input, "phase"));
    if (!c.in_array(phase, ["prify", "draft_goodcode", "ready_goodcode"], true)) {
      throw new Error("Invalid child phase.");
    }
    target = c.clone(targetAt(plan, id, ["running"]));
    if (c.equal(phase, "ready_goodcode") && c.equal(c.get(plan, "skip_ready_goodcode") ?? false, true)) {
      throw new Error("Ready goodcode is skipped by NOREVIEWER.");
    }
    if (c.get(target, "phase_records", phase) != null) {
      throw new Error("Phase already has a record; reconcile it.");
    }
    if (c.equal(phase, "draft_goodcode") && !(c.get(target, "pr_url") != null)) {
      throw new Error("Draft goodcode requires a verified PR.");
    }
    if (c.equal(phase, "ready_goodcode") && c.get(target, "phase_records", "draft_goodcode") != null && (!c.equal(c.get(target, "mutations", "ready", "status") ?? null, "complete") || !c.equal(c.get(reviewerGateRecord(target), "status") ?? null, "complete"))) {
      throw new Error("Promotion and selected-reviewer review must complete first.");
    }
    if (c.equal(phase, "ready_goodcode") && c.get(plan, "reviewer") != null && !c.equal(c.get(reviewerGateRecord(target), "status") ?? null, "complete")) {
      throw new Error("Selected-reviewer gate must complete first.");
    }
    path = c.clone(requiredText(input, "result_path"));
    if (!c.equal(c.get(path, 0), "/") || c.is_link(path) || c.file_exists(path) || !c.is_dir(c.dirname(path))) {
      throw new Error("Expected a new absolute child result path.");
    }
    record = c.clone(c.entriesArray([["status", "pending"], ["result_path", path], ["started_at", c.gmdate("c")]]));
    for (const [_key, _value] of c.entries(["pr_url", "expected_head"])) {
      field = c.clone(_value);
      {
        if (c.get(input, field) != null) {
          c.set(record, [field], "=", requiredText(input, field));
        }
      }
    }
    c.set(plan, ["targets", id, "phase_records", phase], "=", record);
    result = c.clone(c.entriesArray([["event", "phase_pending"], ["target_id", id], ["phase", phase]]));
  } else if (c.equal(action, "phase-adopt")) {
    result = c.clone(adoptChild(plan, input));
  } else if (c.equal(action, "gate-complete")) {
    id = c.clone(requiredText(input, "target_id"));
    target = c.clone(targetAt(plan, id, ["running", "waiting_review"]));
    if (c.get(target, "phase_records", "draft_goodcode") != null && !c.equal(c.get(target, "mutations", "ready", "status") ?? null, "complete") || !c.equal(reviewerGateRecord(target), null)) {
      throw new Error("Promotion missing or reviewer gate already recorded.");
    }
    if (c.equal(c.get(plan, "reviewer") ?? null, "NONE")) {
      throw new Error("Reviewer gate is skipped for NONE.");
    }
    evidencePath = c.clone(requiredText(input, "evidence_path"));
    evidence = c.clone(jsonFile(evidencePath));
    if (c.get(plan, "reviewer") != null && !c.equal(c.get(evidence, "reviewer") ?? null, c.get(plan, "reviewer"))) {
      throw new Error("Completion evidence does not match the selected reviewer.");
    }
    head = c.clone(completionHead(input, target));
    if (!c.equal(c.get(evidence, "status") ?? null, "complete") || !c.equal(c.get(evidence, "pr_url") ?? null, c.get(target, "pr_url") ?? null) || !c.equal(c.get(evidence, "head") ?? null, head)) {
      throw new Error("Reviewer completion evidence does not match the PR head.");
    }
    observedHead(input, requiredText(target, "pr_url"), head);
    c.set(plan, ["targets", id, "published_head"], "=", head);
    c.set(plan, ["targets", id, "phase_records", "reviewer_gate"], "=", c.entriesArray([["status", "complete"], ["evidence_path", evidencePath], ["completed_at", c.gmdate("c")]]));
    result = c.clone(c.entriesArray([["event", "gate_complete"], ["target_id", id]]));
  } else if (c.equal(action, "mutation-start")) {
    id = c.clone(requiredText(input, "target_id"));
    kind = c.clone(requiredText(input, "kind"));
    if (!c.in_array(kind, ["ready", "merge"], true)) {
      throw new Error("Invalid batch mutation kind.");
    }
    target = c.clone(targetAt(plan, id, c.equal(kind, "merge") ? ["complete"] : ["running"]));
    if (c.equal(kind, "merge") && (!c.equal(c.get(plan, "merge_enabled") ?? false, true) || !c.equal(c.get(target, "merge_status") ?? null, "pending"))) {
      throw new Error("Merge is not approved and pending.");
    }
    if (c.get(target, "mutations", kind) != null) {
      throw new Error("Mutation already recorded; reconcile it.");
    }
    pr = c.clone(requiredText(input, "pr_url"));
    head = c.clone(requiredText(input, "expected_head"));
    if (!c.equal(c.get(target, "pr_url") ?? null, pr) || !c.equal(c.get(target, "published_head") ?? null, head)) {
      throw new Error("Mutation identity differs from completed phase.");
    }
    if (c.equal(kind, "ready") && !c.equal(c.get(target, "phase_records", "draft_goodcode", "status") ?? null, "complete")) {
      throw new Error("Draft goodcode is incomplete.");
    }
    if (c.equal(kind, "merge") && !c.equal(c.get(plan, "skip_ready_goodcode") ?? false, true) && !c.equal(c.get(target, "phase_records", "ready_goodcode", "status") ?? null, "complete")) {
      throw new Error("Ready goodcode is incomplete.");
    }
    c.set(plan, ["targets", id, "mutations", kind], "=", c.entriesArray([["status", "pending"], ["pr_url", pr], ["expected_head", head], ["started_at", c.gmdate("c")]]));
    if (c.equal(kind, "merge")) {
      c.set(plan, ["targets", id, "merge_status"], "=", "starting");
    }
    result = c.clone(c.entriesArray([["event", "perform_once"], ["kind", kind], ["target_id", id]]));
  } else if (c.equal(action, "mutation-observe")) {
    id = c.clone(requiredText(input, "target_id"));
    kind = c.clone(requiredText(input, "kind"));
    target = c.clone(targetAt(plan, id, c.equal(kind, "merge") ? ["complete"] : ["running"]));
    intent = c.clone(c.get(target, "mutations", kind) ?? null);
    if (!c.is_array(intent) || !c.equal(c.get(intent, "status") ?? null, "pending")) {
      throw new Error("No pending mutation to reconcile.");
    }
    observedHead(input, requiredText(intent, "pr_url"), requiredText(intent, "expected_head"));
    remote = c.clone(c.get(input, "remote"));
    if (c.equal(kind, "ready") && !c.equal(c.get(remote, "is_draft") ?? null, false)) {
      throw new Error("Ready promotion is not verified.");
    }
    if (c.equal(kind, "merge") && (!c.equal(c.get(remote, "merged") ?? null, true) || !c.is_string(c.get(remote, "merge_commit_url") ?? null) || c.equal(c.get(remote, "merge_commit_url"), ""))) {
      throw new Error("Merge is not verified.");
    }
    c.set(plan, ["targets", id, "mutations", kind, "status"], "=", "complete");
    c.set(plan, ["targets", id, "mutations", kind, "completed_at"], "=", c.gmdate("c"));
    if (c.equal(kind, "merge")) {
      c.set(plan, ["targets", id, "merge_status"], "=", "merged");
      c.set(plan, ["targets", id, "merge_commit_url"], "=", c.get(remote, "merge_commit_url"));
    }
    result = c.clone(c.entriesArray([["event", "mutation_complete"], ["kind", kind], ["target_id", id]]));
  } else if (c.equal(action, "merge-running")) {
    id = c.clone(requiredText(input, "target_id"));
    target = c.clone(targetAt(plan, id, ["complete"]));
    if (!c.equal(c.get(target, "merge_status") ?? null, "starting") || !c.equal(c.get(target, "mutations", "merge", "status") ?? null, "pending")) {
      throw new Error("No starting merge to mark running.");
    }
    c.set(plan, ["targets", id, "merge_status"], "=", "running");
    result = c.clone(c.entriesArray([["event", "merge_running"], ["target_id", id]]));
  } else if (c.equal(action, "target-complete")) {
    id = c.clone(requiredText(input, "target_id"));
    target = c.clone(targetAt(plan, id, ["running", "waiting_review"]));
    skipReady = c.clone(c.equal(c.get(plan, "skip_ready_goodcode") ?? false, true));
    if (!c.truth(skipReady) && !c.equal(c.get(target, "phase_records", "ready_goodcode", "status") ?? null, "complete") || !c.equal(c.get(input, "master_stopped") ?? null, true) || !c.equal(c.get(input, "descendants_stopped") ?? null, true)) {
      throw new Error("Target result or agents are incomplete.");
    }
    if (c.truth(skipReady) && (c.get(target, "phase_records", "ready_goodcode") != null || !c.equal(c.get(input, "remote", "is_draft") ?? null, false) || !(c.get(plan, "reviewer") != null) && c.get(target, "mutations", "ready") != null && !c.equal(c.get(reviewerGateRecord(target), "status") ?? null, "complete"))) {
      throw new Error("NOREVIEWER requires a ready PR and completed promotion gate.");
    }
    if (c.truth(skipReady) && (c.get(target, "phase_records", "prify") != null || c.in_array(c.get(target, "entry_phase") ?? null, ["prify", "draft", "draft_goodcode"], true)) && !c.equal(c.get(target, "phase_records", "draft_goodcode", "status") ?? null, "complete")) {
      throw new Error("Draft goodcode is incomplete.");
    }
    if (c.truth(skipReady) && c.get(target, "phase_records", "draft_goodcode") != null && !c.equal(c.get(target, "mutations", "ready", "status") ?? null, "complete")) {
      throw new Error("Draft PR promotion is incomplete.");
    }
    if (c.get(target, "mutations", "ready") != null && !c.equal(c.get(target, "mutations", "ready", "status") ?? null, "complete")) {
      throw new Error("Ready promotion is unresolved.");
    }
    head = c.clone(completionHead(input, target));
    report = c.clone(jsonFile(requiredText(input, "result_path")));
    if (!c.equal(c.get(report, "status") ?? null, "complete") || !c.equal(c.get(report, "pr_url") ?? null, c.get(target, "pr_url") ?? null) || !c.equal(c.get(report, "published_head") ?? null, head) || !c.equal(c.get(report, "cleanup_success") ?? null, true)) {
      throw new Error("Target result identity or cleanup is incomplete.");
    }
    if (c.truth(skipReady) && !c.equal(c.get(report, "ready_goodcode_status") ?? null, "skipped_noreviewer")) {
      throw new Error("NOREVIEWER skip is missing from the target result.");
    }
    observedHead(input, requiredText(target, "pr_url"), head);
    c.set(plan, ["targets", id, "published_head"], "=", head);
    c.set(plan, ["targets", id, "status"], "=", "complete");
    c.set(plan, ["targets", id, "result_path"], "=", c.get(input, "result_path"));
    c.set(plan, ["targets", id, "merge_status"], "=", c.equal(c.get(plan, "merge_enabled") ?? false, true) ? "pending" : "skipped_not_requested");
    result = c.clone(c.entriesArray([["event", "target_complete"], ["target_id", id]]));
  } else if (c.equal(action, "target-resume")) {
    result = c.clone(resumeTarget(plan, input));
  } else if (c.equal(action, "target-blocked")) {
    id = c.clone(requiredText(input, "target_id"));
    targetAt(plan, id, ["starting", "running", "waiting_review"]);
    if (!c.equal(c.get(input, "master_stopped") ?? null, true) || !c.equal(c.get(input, "descendants_stopped") ?? null, true)) {
      throw new Error("Active agents must stop before releasing the target slot.");
    }
    c.set(plan, ["targets", id, "status"], "=", "blocked");
    c.set(plan, ["targets", id, "blocker"], "=", c.entriesArray([["reason", requiredText(input, "reason")], ["evidence_path", requiredText(input, "evidence_path")]]));
    jsonFile(c.get(input, "evidence_path"));
    result = c.clone(c.entriesArray([["event", "target_blocked"], ["target_id", id]]));
  } else if (c.equal(action, "merge-blocked")) {
    id = c.clone(requiredText(input, "target_id"));
    target = c.clone(targetAt(plan, id, ["complete"]));
    if (!c.in_array(c.get(target, "merge_status") ?? null, ["pending", "starting", "running"], true)) {
      throw new Error("Merge is not pending.");
    }
    if (c.equal(c.get(target, "mutations", "merge", "status") ?? null, "pending")) {
      observedHead(input, c.get(target, "pr_url"), c.get(target, "published_head"));
      if (!c.equal(c.get(input, "remote", "merged") ?? null, false)) {
        throw new Error("Uncertain merge must be reconciled first.");
      }
      c.set(plan, ["targets", id, "mutations", "merge", "status"], "=", "blocked");
    }
    c.set(plan, ["targets", id, "merge_status"], "=", "blocked");
    c.set(plan, ["targets", id, "merge_blocker"], "=", requiredText(input, "reason"));
    result = c.clone(c.entriesArray([["event", "merge_blocked"], ["target_id", id]]));
  } else {
    throw new Error("Unknown batch action.");
  }
  c.set(plan, ["state_revision"], "=", c.add(c.get(plan, "state_revision") ?? 0, 1));
  return [plan, c.add(result, c.entriesArray([["state_revision", c.get(plan, "state_revision")]]))];
}
module.exports = {
  requiredText,
  reviewerGateRecord,
  validateReviewProfile,
  jsonFile,
  publishJson,
  lockedPlan,
  approved,
  targetAt,
  observedHead,
  adoptChild,
  inspectTarget,
  resumeTarget,
  changePlan
};
if (require.main === module) {
  try {
    let result;
    if (process.argv[2] === '--locked') {
      const input = c.json_decode(require('node:fs').readFileSync(0, 'utf8'));
      result = lockedPlan(requiredText(input, 'plan_path'), plan => changePlan(plan, input));
    } else {
      const input = jsonFile(process.argv[2] ?? '');
      result = c.lockedCommand(requiredText(input, 'plan_path') + '.state.lock', __filename, ['--locked'], input);
    }
    process.stdout.write(c.json_encode({
      ok: true,
      result
    }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      event: 'blocked',
      error: error.message
    }) + '\n');
    process.exitCode = 1;
  }
}
