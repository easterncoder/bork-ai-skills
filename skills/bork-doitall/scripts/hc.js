'use strict';

const c = require("../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };
let action, environment, error, input, result, run, session, source;

/** Decode the documented direct hc JSON response, rejecting error envelopes. */
function hcReply(args, run) {
  c.assertType(args, "array", "hcReply.args");
  c.assertType(run, "callable", "hcReply.run");
  run = c.callable(run);
  run = c.callable(run);
  let reply;
  args = c.clone(args);
  run = c.clone(run);
  reply = c.clone(c.json_decode(run(c.array_merge(["hc"], args)), true, 512, c.JSON_THROW_ON_ERROR));
  if (!c.is_array(reply) || c.get(reply, "error") != null) {
    throw new Error("hc command failed; reconcile the recorded terminal before retrying.");
  }
  return reply;
}
/** Require a local persistent terminal identity and its process provenance. */
function validateHcIdentity(identity) {
  c.assertType(identity, "array", "validateHcIdentity.identity");
  identity = c.clone(identity);
  if (!c.truth(c.preg_match("/^t[0-9a-z]+$/D", c.get(identity, "terminal_id") ?? "")) || !c.is_string(c.get(identity, "core_id") ?? null) || c.equal(c.get(identity, "core_id"), "") || !c.is_int(c.get(identity, "pid") ?? null) || c.get(identity, "pid") < 1 || !c.is_int(c.get(identity, "created_ms") ?? null)) {
    throw new Error("hc terminal identity evidence is incomplete.");
  }
}
/** Verify the installed manual and required command flags without creating terminals. */
function hcCapabilities(run) {
  c.assertType(run, "callable", "hcCapabilities.run");
  run = c.callable(run);
  run = c.callable(run);
  let command, flag, manual;
  run = c.clone(run);
  manual = c.clone(run(["hc", "--skill"]));
  if (!c.str_contains(manual, "--no-daemon") || !c.str_contains(manual, "first_message.sent")) {
    throw new Error("Installed hc manual lacks the required agent delivery contract.");
  }
  for (const [_key, _value] of c.entries(c.entriesArray([["run", "--bg"], ["send", "--if"], ["wait", "--timeout"], ["get", "TERMINAL"], ["read", "--lines"], ["interrupt", "TERMINAL"], ["kill", "TERMINAL"], ["rm", "TERMINAL"]]))) {
    command = _key;
    flag = c.clone(_value);
    {
      if (!c.str_contains(run(["hc", command, "--help"]), flag)) {
        throw new Error(c.string("Missing hc capability: ") + c.string(command));
      }
    }
  }
  return c.entriesArray([["version", run(["hc", "--version"])], ["manual_sha256", c.hash("sha256", manual)]]);
}
/** Verify inherited caller membership without treating installation as membership. */
function detectHcContext(env, run, ancestor) {
  c.assertType(env, "callable", "detectHcContext.env");
  env = c.callable(env);
  c.assertType(run, "callable", "detectHcContext.run");
  run = c.callable(run);
  c.assertType(ancestor, "callable", "detectHcContext.ancestor");
  ancestor = c.callable(ancestor);
  env = c.callable(env);
  run = c.callable(run);
  ancestor = c.callable(ancestor);
  let id, identity, server, terminal;
  env = c.clone(env);
  run = c.clone(run);
  ancestor = c.clone(ancestor);
  id = c.clone(env("HC_TERMINAL_ID"));
  if (c.equal(id, false) || c.equal(id, "")) {
    return c.entriesArray([["active", false]]);
  }
  if (!c.is_string(id) || !c.truth(c.preg_match("/^t[0-9a-z]+$/D", id))) {
    throw new Error("Invalid explicit hc caller terminal.");
  }
  terminal = c.clone(hcReply(["get", id], run));
  server = c.clone(hcReply(["server", "status"], run));
  identity = c.clone(c.entriesArray([["active", true], ["terminal_id", id], ["core_id", c.get(server, "core", "id") ?? null], ["pid", c.get(terminal, "pid") ?? null], ["created_ms", c.get(terminal, "created_ms") ?? null], ["session", c.truth(env("HC_SESSION")) ? env("HC_SESSION") : null]]));
  validateHcIdentity(identity);
  if (!c.equal(c.get(terminal, "address") ?? null, id) || !c.equal(c.get(terminal, "state") ?? null, "live") || !c.truth(ancestor(c.get(identity, "pid")))) {
    throw new Error("Explicit hc caller is stale or not an ancestor of this process.");
  }
  return c.add(identity, c.entriesArray([["capabilities", hcCapabilities(run)]]));
}
/** Atomically retain lifecycle intent and replies outside disposable worktrees. */
function hcRecord(path, data) {
  c.assertType(path, "string", "hcRecord.path");
  c.assertType(data, "array", "hcRecord.data");
  c.atomicWrite(path, c.json_encode(data, c.JSON_PRETTY_PRINT), '.hc-');
}

/** Bind every operation to the original core and the exact owned terminal. */
function hcOwned(record, run) {
  c.assertType(record, "array", "hcOwned.record");
  c.assertType(run, "callable", "hcOwned.run");
  run = c.callable(run);
  run = c.callable(run);
  let server, terminal;
  record = c.clone(record);
  run = c.clone(run);
  server = c.clone(hcReply(["server", "status"], run));
  if (!c.equal(c.get(server, "core", "id") ?? null, require("./terminal.js").field(record, "core_id"))) {
    throw new Error("hc core changed; reconcile before continuing.");
  }
  terminal = c.clone(hcReply(["get", require("./terminal.js").field(record, "terminal_id")], run));
  if (!c.equal(c.get(terminal, "address") ?? null, c.get(record, "terminal_id")) || !c.equal(c.get(terminal, "created_ms") ?? null, c.get(record, "created_ms") ?? null) || !c.equal(c.get(terminal, "labels", "bork-run") ?? null, require("./terminal.js").field(record, "run_id")) || !c.equal(c.get(terminal, "name") ?? null, require("./terminal.js").field(record, "name"))) {
    throw new Error("hc terminal ownership changed; preserve it.");
  }
  return terminal;
}
/** Classify lifecycle evidence without interpreting idle status as task success. */
function hcObservation(terminal) {
  c.assertType(terminal, "array", "hcObservation.terminal");
  terminal = c.clone(terminal);
  if (c.equal(c.get(terminal, "status", "state") ?? null, "blocked")) {
    return "attention";
  }
  if (c.equal(c.get(terminal, "state") ?? null, "finished")) {
    return "stopped_requires_result";
  }
  return "requires_result_and_ack";
}
/** Bind or restore the stable visible slot while preserving the user's final focus. */
function hcLayoutShow(record, show = true) {
  c.assertType(record, "array", "hcLayoutShow.record");
  c.assertType(show, "bool", "hcLayoutShow.show");
  record = c.clone(record);
  show = c.clone(show);
  if (!(c.get(record, "layout_record") != null && c.get(record, "placement") != null)) {
    return;
  }
  require("./layout.js").borkLayoutAction("bind", c.entriesArray([["record", c.get(record, "layout_record")], ["placement", c.string(c.string(c.get(record, "role")) + c.string(":")) + c.string(c.get(record, "slot"))], ["task_id", c.get(record, "task_id")], ["run_id", c.get(record, "run_id")], ["terminal_id", c.get(record, "terminal_id")], ["created_ms", c.get(record, "created_ms")], ["show", show]]));
}
/** Launch interactive roles and retain uncertain operations for explicit reconciliation. */
function hcAction(action, input, run) {
  c.assertType(action, "string", "hcAction.action");
  c.assertType(input, "array", "hcAction.input");
  c.assertType(run, "callable", "hcAction.run");
  run = c.callable(run);
  run = c.callable(run);
  let ack, args, argv, attention, candidate, job, key, labels, layout, matches, mode, path, record, reply, server, session, terminal;
  action = c.clone(action);
  input = c.clone(input);
  run = c.clone(run);
  path = c.clone(require("./terminal.js").field(input, "record"));
  if (c.equal(action, "launch")) {
    if (c.file_exists(path) || c.is_link(path)) {
      throw new Error("Launch record exists; reconcile instead of launching twice.");
    }
    job = c.clone(require("./terminal.js").readInput(require("./terminal.js").field(input, "job")));
    require("./terminal.js").validateJob(job);
    argv = c.clone(c.get(job, "argv"));
    mode = c.clone(require("./provider-command.js").validateProviderCommand(argv));
    if (!c.truth(c.get(mode, "interactive"))) {
      throw new Error("hc roles require an interactive provider command.");
    }
    hcCapabilities(run);
    if (!c.in_array(c.get(input, "role") ?? "", ["master", "review", "fix"], true) || !c.truth(c.preg_match("/^[a-z0-9_-]{1,32}$/D", require("./terminal.js").field(input, "name"))) || !c.is_dir(require("./terminal.js").field(input, "cwd"))) {
      throw new Error("Invalid hc role, name or working directory.");
    }
    server = c.clone(hcReply(["server", "status"], run));
    record = c.clone(c.array_replace(input, c.entriesArray([["core_id", c.get(server, "core", "id") ?? null], ["state", "launch_uncertain"]])));
    require("./terminal.js").field(record, "core_id");
    require("./terminal.js").field(record, "run_id");
    require("./terminal.js").field(record, "task_id");
    if (c.get(input, "layout_record") != null) {
      layout = c.clone(require("./terminal.js").readInput(require("./terminal.js").field(input, "layout_record")));
      if (!c.equal(c.get(layout, "driver"), "hc") || !c.equal(c.get(layout, "context", "session") ?? null, c.get(input, "session") ?? null) || !c.equal(c.get(layout, "context", "core_id"), c.get(record, "core_id"))) {
        throw new Error("App layout and worker must use the same recorded core/session.");
      }
      c.set(record, ["placement"], "=", require("./layout.js").borkLayoutAction("claim", c.array_replace(input, c.entriesArray([["record", c.get(input, "layout_record")]]))));
      if (!c.get(c.get(record, "placement"), "id")) throw new Error("Visual admission is waiting or blocked; retain capacity result before launching a worker.");
    }
    hcRecord(path, record);
    /* The CLI task is in argv at launch, never sent to a booting agent. */
    labels = c.clone(["--label", c.string("bork-run=") + c.string(c.get(record, "run_id"))]);
    if (c.get(record, "layout_record") != null) {
      c.array_push(labels, "--label", c.string("bork-task=") + c.string(c.get(record, "task_id")));
    }
    reply = c.clone(hcReply(c.array_merge(["run", "--json", "--bg", "--name", c.get(input, "name"), "--cwd", c.get(input, "cwd")], labels, argv), run));
    c.set(record, ["terminal_id"], "=", c.get(reply, "address") ?? null);
    c.set(record, ["launch_reply"], "=", reply);
    c.set(record, ["state"], "=", c.truth(c.get(reply, "first_message", "sent") ?? false) ? "awaiting_result" : "delivery_requires_reconciliation");
    hcRecord(path, record);
    terminal = c.clone(hcReply(["get", require("./terminal.js").field(record, "terminal_id")], run));
    c.set(record, ["created_ms"], "=", c.get(terminal, "created_ms") ?? null);
    hcRecord(path, record);
    hcOwned(record, run);
    hcLayoutShow(record);
    return record;
  }
  record = c.clone(require("./terminal.js").readInput(path));
  if (c.equal(action, "reconcile")) {
    server = c.clone(hcReply(["server", "status"], run));
    if (!c.equal(c.get(server, "core", "id") ?? null, require("./terminal.js").field(record, "core_id"))) {
      throw new Error("hc core changed during launch reconciliation.");
    }
    matches = c.clone([]);
    for (const [_key, _value] of c.entries(c.get(hcReply(["ls", "--all"], run), "terminals") ?? [])) {
      candidate = c.clone(_value);
      {
        if (c.equal(c.get(candidate, "name") ?? null, require("./terminal.js").field(record, "name"))) {
          c.append(matches, [], hcReply(["get", require("./terminal.js").field(candidate, "address")], run));
        }
      }
    }
    if (!c.equal(c.count(matches), 1) || !c.equal(c.get(matches, 0, "labels", "bork-run") ?? null, require("./terminal.js").field(record, "run_id"))) {
      throw new Error("Uncertain launch is not uniquely attributable; preserve evidence and do not retry.");
    }
    if (c.get(record, "terminal_id") != null && !c.equal(c.get(record, "terminal_id"), c.get(matches, 0, "address")) || c.get(record, "created_ms") != null && !c.equal(c.get(record, "created_ms"), c.get(matches, 0, "created_ms"))) {
      throw new Error("Recorded hc terminal was replaced; preserve the new occupant.");
    }
    c.set(record, ["terminal_id"], "=", c.get(matches, 0, "address"));
    c.set(record, ["created_ms"], "=", c.get(matches, 0, "created_ms"));
    hcRecord(path, record);
    hcOwned(record, run);
    hcLayoutShow(record);
    return record;
  }
  terminal = c.clone(hcOwned(record, run));
  if (c.equal(action, "acknowledge")) {
    ack = c.clone(require("./terminal.js").readInput(require("./terminal.js").field(input, "acknowledgment")));
    for (const [_key, _value] of c.entries(["run_id", "terminal_id", "task_id"])) {
      key = c.clone(_value);
      {
        if (!c.equal(require("./terminal.js").field(ack, key), require("./terminal.js").field(record, key))) {
          throw new Error("Task acknowledgment identity mismatch.");
        }
      }
    }
    c.set(record, ["acknowledgment"], "=", c.get(input, "acknowledgment"));
    c.set(record, ["state"], "=", "acknowledged_requires_result");
    hcRecord(path, record);
    return record;
  }
  if (c.equal(action, "inspect")) {
    attention = c.clone(c.equal(hcObservation(terminal), "attention") ? run(["hc", "read", c.get(record, "terminal_id"), "--lines", "120"]) : null);
    session = c.clone(c.get(record, "session") ?? null);
    return c.entriesArray([["prompt_output", attention], ["terminal", terminal], ["observation", hcObservation(terminal)], ["navigation", c.equal(session, null) ? c.string("hc attach ") + c.string(c.get(record, "terminal_id")) : null], ["navigation_environment", c.equal(session, null) ? [] : c.entriesArray([["HC_SESSION", session]])], ["navigation_argv", ["hc", "attach", c.get(record, "terminal_id")]]]);
  }
  if (c.equal(action, "wait")) {
    return hcReply(["wait", c.get(record, "terminal_id"), "--timeout", "30"], run);
  }
  if (c.equal(action, "send")) {
    if (!c.equal(c.get(terminal, "state") ?? null, "live") || !c.in_array(c.get(terminal, "status", "state") ?? null, ["idle", "done"], true) || c.equal(c.get(record, "state") ?? null, "send_uncertain")) {
      throw new Error("Read and reconcile readiness or uncertain delivery before sending; never force a prompt.");
    }
    c.set(record, ["state"], "=", "send_uncertain");
    c.set(record, ["pending_task"], "=", require("./terminal.js").field(input, "task"));
    c.set(record, ["task_id"], "=", require("./terminal.js").field(input, "task_id"));
    hcRecord(path, record);
    args = c.clone(c.equal(c.get(terminal, "status", "state") ?? null, "idle") ? ["send", "--if", "idle"] : ["send"]);
    reply = c.clone(hcReply(c.array_merge(args, [c.get(record, "terminal_id"), c.get(input, "task")]), run));
    c.set(record, ["send_reply"], "=", reply);
    /* A successful send still needs a matching task acknowledgment. */
    hcRecord(path, record);
    return reply;
  }
  if (c.equal(action, "interrupt")) {
    return hcReply(["interrupt", c.get(record, "terminal_id")], run);
  }
  if (c.equal(action, "cleanup")) {
    /* The owner accepts results and stops native descendants before this call. */
    if (!c.equal(c.get(input, "results_verified") ?? false, true) || !c.equal(c.get(input, "descendants_stopped") ?? false, true)) {
      throw new Error("Verified result and stopped-descendant evidence are required.");
    }
    c.set(record, ["final_terminal"], "=", terminal);
    c.set(record, ["output"], "=", run(["hc", "read", c.get(record, "terminal_id"), "--lines", "120"]));
    c.set(record, ["state"], "=", "cleanup_pending");
    hcRecord(path, record);
    if (!c.equal(c.get(terminal, "state") ?? null, "finished")) {
      hcReply(["kill", c.get(record, "terminal_id")], run);
    }
    terminal = c.clone(hcOwned(record, run));
    if (!c.equal(c.get(terminal, "state") ?? null, "finished")) {
      throw new Error("hc process has not stopped.");
    }
    c.set(record, ["exit_terminal"], "=", terminal);
    const layoutJournal = record.layout_record ? require('./terminal.js').readInput(record.layout_record) : null;
    if (layoutJournal?.version === 2) {
      require('./layout.js').borkLayoutAction('release', {record: record.layout_record, placement: `${record.role}:${record.slot}`, task_id: record.task_id, result_path: require('./terminal.js').field(input, 'result_path'), results_verified: true, worker_stopped: true, descendants_stopped: true});
    } else hcLayoutShow(record, false);
    c.set(record, ["remove_reply"], "=", hcReply(["rm", c.get(record, "terminal_id")], run));
    if (!c.equal(c.get(record, "remove_reply", "removed") ?? null, c.get(record, "terminal_id"))) {
      throw new Error("hc removal response does not match the owned terminal.");
    }
    c.set(record, ["state"], "=", "removed");
    hcRecord(path, record);
    return record;
  }
  throw new Error("Unknown hc action.");
}
module.exports = {
  hcReply,
  validateHcIdentity,
  hcCapabilities,
  detectHcContext,
  hcRecord,
  hcOwned,
  hcObservation,
  hcLayoutShow,
  hcAction
};
if (require.main === module) {
  try {
    action = c.clone(c.get(argv, 1) ?? "");
    input = c.clone(require("./terminal.js").readInput(c.get(argv, 2) ?? ""));
    source = c.clone(c.equal(action, "launch") ? input : require("./terminal.js").readInput(require("./terminal.js").field(input, "record")));
    session = c.clone(c.array_key_exists("session", source) ? c.get(source, "session") : c.truth(c.getenv("HC_SESSION")) ? c.getenv("HC_SESSION") : null);
    if (!c.equal(session, null) && (!c.is_string(session) || c.equal(session, "") || c.truth(c.preg_match("/[\\x00\\r\\n]/", session)))) {
      throw new Error("Invalid hc session routing identity.");
    }
    environment = c.clone(c.getenv());
    c.set(environment, ["HC_SESSION"], "DELETE", null);
    if (!c.equal(session, null)) {
      c.set(environment, ["HC_SESSION"], "=", session);
    }
    c.set(input, ["session"], "=", session);
    run = function (args) {
      args = c.clone(args);
      return require("./terminal.js").execute(args, [0], environment);
    };
    result = c.clone(hcAction(action, input, run));
    process.stdout.write(c.string(c.string(c.json_encode(c.entriesArray([["ok", true], ["result", result]]), c.JSON_THROW_ON_ERROR)) + c.string("\n")));
  } catch (error) {
    process.stdout.write(c.string(c.string(c.json_encode(c.entriesArray([["ok", false], ["event", "blocked"], ["error", error.message]]), c.JSON_INVALID_UTF8_SUBSTITUTE)) + c.string("\n")));
    c.exit(1);
  }
}
