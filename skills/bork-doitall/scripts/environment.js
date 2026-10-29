'use strict';

const c = require("../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };
let args, contexts, driver, error, input, prefix, result, runtime, terminalCommand;

/** Run a local command with a bounded observation period and explicit environment. */
function environmentCommand(args, environment = null) {
  c.assertType(args, "array", "environmentCommand.args");
  c.assertType(environment, "?array", "environmentCommand.environment");
  const result = c.processResult(args, {
    env: environment === null ? undefined : c.object(environment),
    timeout: 5000
  });
  if (result.error?.code === 'ETIMEDOUT') throw new Error('Session discovery timed out; reconcile explicit context.');
  if (result.error || result.code !== 0) throw new Error('Session discovery failed for ' + args[0] + '; verify the inherited context and local command access (ps is required for ancestry verification).');
  return result.output.trim();
}

/** Verify that a live pane shell is an ancestor of this invoking process. */
function environmentAncestor(shell, run, caller = null) {
  c.assertType(shell, "int", "environmentAncestor.shell");
  c.assertType(run, "callable", "environmentAncestor.run");
  run = c.callable(run);
  c.assertType(caller, "?int", "environmentAncestor.caller");
  run = c.callable(run);
  let line, match, parents, pid, seen;
  shell = c.clone(shell);
  run = c.clone(run);
  caller = c.clone(caller);
  parents = c.clone([]);
  for (const [_key, _value] of c.entries(c.explode("\n", run(["ps", "-eo", "pid=,ppid="])))) {
    line = c.clone(_value);
    {
      if (c.truth(c.preg_match("/^\\s*(\\d+)\\s+(\\d+)\\s*$/", line, _m => {
        match = _m;
      }))) {
        c.set(parents, [c.integer(c.get(match, 1))], "=", c.integer(c.get(match, 2)));
      }
    }
  }
  pid = c.clone(caller ?? c.getmypid());
  seen = c.clone([]);
  while (pid > 0 && !(c.get(seen, pid) != null)) {
    if (c.equal(pid, shell)) {
      return true;
    }
    c.set(seen, [pid], "=", true);
    pid = c.clone(c.get(parents, pid) ?? 0);
  }
  return false;
}
/** Decode only a successful Herdr response from the inherited local session. */
function environmentHerdr(args, run) {
  c.assertType(args, "array", "environmentHerdr.args");
  c.assertType(run, "callable", "environmentHerdr.run");
  run = c.callable(run);
  run = c.callable(run);
  let reply;
  args = c.clone(args);
  run = c.clone(run);
  reply = c.clone(c.json_decode(run(c.array_merge(["herdr"], args)), true, 512, c.JSON_THROW_ON_ERROR));
  if (c.get(reply, "error") != null || !c.is_array(c.get(reply, "result") ?? null)) {
    throw new Error("Herdr session response is not verifiable.");
  }
  return c.get(reply, "result");
}
/** Detect membership independently of workflow capacity or installed executables. */
function detectEnvironment(env, run, ancestor, expectedEnvironment = null) {
  c.assertType(env, "callable", "detectEnvironment.env");
  env = c.callable(env);
  c.assertType(run, "callable", "detectEnvironment.run");
  run = c.callable(run);
  c.assertType(ancestor, "callable", "detectEnvironment.ancestor");
  ancestor = c.callable(ancestor);
  c.assertType(expectedEnvironment, "?string", "detectEnvironment.expectedEnvironment");
  env = c.callable(env);
  run = c.callable(run);
  ancestor = c.callable(ancestor);
  let contexts, format, herdr, herdrKeys, match, pane, process, reply, socket, tmux;
  env = c.clone(env);
  run = c.clone(run);
  ancestor = c.clone(ancestor);
  expectedEnvironment = c.clone(expectedEnvironment);
  if (!c.equal(expectedEnvironment, null) && !c.in_array(expectedEnvironment, ["hc", "herdr", "tmux", "screen"], true)) {
    throw new Error("Unknown expected terminal environment.");
  }
  contexts = c.clone(c.entriesArray([["hc", require("./hc.js").detectHcContext(env, run, ancestor)], ["herdr", c.entriesArray([["active", false]])], ["tmux", c.entriesArray([["active", false]])], ["screen", c.entriesArray([["active", false]])]]));
  herdrKeys = c.clone(["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SOCKET_PATH"]);
  herdr = c.clone(c.array_combine(herdrKeys, c.array_map(env, herdrKeys)));
  if (c.count(c.array_filter(herdr, function (value) {
    value = c.clone(value);
    return !c.equal(value, false) && !c.equal(value, "");
  })) > 0) {
    if (!c.equal(c.get(herdr, "HERDR_ENV"), "1") || !c.truth(c.get(herdr, "HERDR_PANE_ID")) || !c.truth(c.get(herdr, "HERDR_SOCKET_PATH")) || !c.truth(c.get(herdr, "HERDR_TAB_ID")) || !c.truth(c.get(herdr, "HERDR_WORKSPACE_ID"))) {
      throw new Error("Explicit Herdr context is incomplete; restore the managed pane environment.");
    }
    /* The inherited caller ID remains an alias when a pane moves. */
    pane = c.clone(c.get(environmentHerdr(["pane", "current", "--current"], run), "pane") ?? null);
    process = c.clone(c.get(environmentHerdr(["pane", "process-info", "--current"], run), "process_info") ?? null);
    if (!c.is_array(pane) || !c.is_array(process) || !c.is_string(c.get(pane, "pane_id") ?? null) || c.equal(c.get(pane, "pane_id"), "") || !c.is_string(c.get(pane, "tab_id") ?? null) || c.equal(c.get(pane, "tab_id"), "") || !c.is_string(c.get(pane, "workspace_id") ?? null) || c.equal(c.get(pane, "workspace_id"), "") || !c.equal(c.get(process, "pane_id") ?? null, c.get(pane, "pane_id")) || !c.is_int(c.get(process, "shell_pid") ?? null) || !c.truth(ancestor(c.get(process, "shell_pid")))) {
      throw new Error("Explicit Herdr pane is stale or not an ancestor of this process; reconcile membership.");
    }
    c.set(contexts, ["herdr"], "=", c.entriesArray([["active", true], ["pane_id", c.get(pane, "pane_id")], ["tab_id", c.get(pane, "tab_id")], ["workspace_id", c.get(pane, "workspace_id")], ["socket", c.get(herdr, "HERDR_SOCKET_PATH")], ["shell_pid", c.get(process, "shell_pid")]]));
  }
  tmux = c.clone(env("TMUX"));
  pane = c.clone(env("TMUX_PANE"));
  if (!c.equal(tmux, false) && !c.equal(tmux, "") || !c.equal(pane, false) && !c.equal(pane, "")) {
    if (!c.is_string(tmux) || !c.truth(c.preg_match("/^(.*),(\\d+),(\\d+)$/D", tmux, _m => {
      match = _m;
    })) || c.equal(c.get(match, 1), "") || !c.is_string(pane) || !c.truth(c.preg_match("/^%\\d+$/D", pane))) {
      throw new Error("Explicit tmux context is incomplete; restore TMUX and TMUX_PANE in the live pane.");
    }
    socket = c.clone(c.get(match, 1));
    format = "#{pane_id}|#{pane_pid}|#{socket_path}|#{pid}|#{session_id}";
    reply = c.clone(c.explode("|", run(["tmux", "-S", socket, "display-message", "-p", "-t", pane, format])));
    if (!c.equal(c.count(reply), 5) || !c.equal(c.get(reply, 0), pane) || !c.ctype_digit(c.get(reply, 1)) || !c.equal(c.get(reply, 2), socket) || !c.equal(c.get(reply, 3), c.get(match, 2)) || !c.equal(c.get(reply, 4), c.string("$") + c.string(c.get(match, 3))) || !c.truth(ancestor(c.integer(c.get(reply, 1))))) {
      throw new Error("Explicit tmux context is stale or belongs to another process; reconcile the live socket and pane.");
    }
    c.set(contexts, ["tmux"], "=", c.entriesArray([["active", true], ["pane_id", pane], ["socket", socket], ["shell_pid", c.integer(c.get(reply, 1))], ["session_id", c.get(reply, 4)]]));
  }
  c.set(contexts, ["screen"], "=", require("./screen-context.js").detectScreenContext(env, run, ancestor));
  if (!c.equal(expectedEnvironment, null) && !c.truth(c.get(contexts, expectedEnvironment, "active"))) {
    throw new Error(c.string(c.string("Reported ") + c.string(expectedEnvironment)) + c.string(" membership is not visible to this tool process; verify discovery in the invoking terminal. A sandbox, environment filter or detached tool backend may hide caller context. Do not select another driver or copy context from an unrelated process."));
  }
  return contexts;
}
/** Choose by verified membership, then require the selected driver's capacity. */
function selectEnvironment(contexts, capabilities) {
  c.assertType(contexts, "array", "selectEnvironment.contexts");
  c.assertType(capabilities, "array", "selectEnvironment.capabilities");
  let capability, driver, reason, selected;
  contexts = c.clone(contexts);
  capabilities = c.clone(capabilities);
  c.set(contexts, ["screen"], "??=", c.entriesArray([["active", false]]));
  c.set(contexts, ["hc"], "??=", c.entriesArray([["active", false]]));
  for (const [_key, _value] of c.entries(["hc", "herdr", "tmux", "screen"])) {
    driver = c.clone(_value);
    {
      if (!c.is_bool(c.get(contexts, driver, "active") ?? null)) {
        throw new Error(c.string("Missing verified membership: ") + c.string(driver));
      }
    }
  }
  selected = "native";
  for (const [_key, _value] of c.entries(["hc", "herdr", "tmux", "screen"])) {
    driver = c.clone(_value);
    {
      if (c.truth(c.get(contexts, driver, "active"))) {
        selected = c.clone(driver);
        break;
      }
    }
  }
  capability = c.clone(c.get(capabilities, selected) ?? null);
  if (!c.is_array(capability) || !c.equal(c.get(capability, "supported") ?? null, true) || !c.is_string(c.get(capability, "evidence") ?? null) || c.equal(c.trim(c.get(capability, "evidence")), "")) {
    reason = c.clone(c.is_array(capability) && c.is_string(c.get(capability, "blocker") ?? null) ? c.get(capability, "blocker") : "verified workflow capacity evidence is missing");
    throw new Error(c.string(c.string(c.string(c.string("Selected driver ") + c.string(selected)) + c.string(" is blocked: ")) + c.string(reason)) + c.string(". No fallback is permitted."));
  }
  return c.entriesArray([["version", 1], ["execution_driver", selected], ["contexts", contexts], ["capability", capability]]);
}
/** Validate additive selection evidence without reinterpreting legacy approvals. */
function validateEnvironmentSelection(plan) {
  c.assertType(plan, "array", "validateEnvironmentSelection.plan");
  let checked, context, driver, selected, selection;
  plan = c.clone(plan);
  if (c.get(plan, "execution_driver") != null && !c.in_array(c.get(plan, "execution_driver"), ["native", "hc", "tmux", "screen", "herdr"], true)) {
    throw new Error("Unknown recorded execution driver.");
  }
  if (!c.array_key_exists("environment_selection", plan)) {
    return;
  }
  selection = c.clone(c.get(plan, "environment_selection"));
  if (!c.is_array(selection) || !c.equal(c.get(selection, "version") ?? null, 1)) {
    throw new Error("Unsupported environment selection evidence.");
  }
  if (c.equal(c.get(selection, "contexts", "hc", "active") ?? false, true)) {
    require("./hc.js").validateHcIdentity(c.get(selection, "contexts", "hc"));
  }
  for (const [_key, _value] of c.entries(["herdr", "tmux", "screen"])) {
    driver = c.clone(_value);
    {
      context = c.clone(c.get(selection, "contexts", driver) ?? []);
      if (c.equal(c.get(context, "active") ?? false, true) && (!c.is_string(c.get(context, "pane_id") ?? null) || c.equal(c.get(context, "pane_id"), "") || !c.is_string(c.get(context, "socket") ?? null) || c.equal(c.get(context, "socket"), "") || !c.is_int(c.get(context, "shell_pid") ?? null) || c.get(context, "shell_pid") < 1)) {
        throw new Error(c.string("Active session identity evidence is missing: ") + c.string(driver));
      }
    }
  }
  selected = c.clone(c.get(selection, "execution_driver") ?? "");
  checked = c.clone(selectEnvironment(c.get(selection, "contexts") ?? [], c.entriesArray([[selected, c.get(selection, "capability") ?? null]])));
  if (!c.equal(c.get(plan, "execution_driver") ?? null, c.get(checked, "execution_driver")) || !c.equal(selected, c.get(checked, "execution_driver"))) {
    throw new Error("Recorded driver differs from approved environment selection.");
  }
}
module.exports = {
  environmentCommand,
  environmentAncestor,
  environmentHerdr,
  detectEnvironment,
  selectEnvironment,
  validateEnvironmentSelection
};
if (require.main === module) {
  try {
    terminalCommand = c.clone(c.in_array(c.get(argv, 1) ?? "", ["hc", "herdr", "tmux", "screen"], true) ? c.get(argv, 1) : null);
    input = c.clone(!c.equal(terminalCommand, null) ? c.entriesArray([["expected_environment", terminalCommand]]) : c.json_decode(c.file_get_contents(c.get(argv, 1) ?? "/dev/stdin"), true, 512, c.JSON_THROW_ON_ERROR));
    runtime = c.clone(require("./terminal-context.js").environmentRuntime(c.get(input, "expected_environment") ?? null));
    contexts = c.clone(detectEnvironment(c.get(runtime, "env"), c.get(runtime, "run"), c.get(runtime, "ancestor"), c.get(input, "expected_environment") ?? null));
    if (!c.equal(c.get(runtime, "frontend"), null)) {
      for (const [_key, _value] of c.entries(["hc", "herdr", "tmux", "screen"])) {
        driver = c.clone(_value);
        {
          if (c.truth(c.get(contexts, driver, "active"))) {
            c.set(contexts, [driver, "frontend"], "=", c.get(runtime, "frontend"));
          }
        }
      }
    }
    if (!c.equal(terminalCommand, null)) {
      args = c.clone(c.array_slice(argv, 2));
      if (c.equal(args, []) || !c.equal(terminalCommand, "screen") && c.str_starts_with(c.get(args, 0), "-")) {
        throw new Error("Supply a local terminal command group; socket, session and remote overrides are not supported.");
      }
      prefix = c.clone((_match => c.equal(_match, "tmux") ? ["tmux", "-S", c.get(contexts, "tmux", "socket")] : c.equal(_match, "screen") ? ["screen", "-S", c.get(contexts, "screen", "session_id"), "-p", c.get(contexts, "screen", "pane_id")] : c.equal(_match, "hc") ? ["hc"] : ["herdr"])(terminalCommand));
      if (c.equal(terminalCommand, "screen") && !c.in_array(c.get(args, 0), ["-Q", "-X"], true)) {
        throw new Error("Screen wrapper requires -Q or -X.");
      }
      process.stdout.write(c.string(c.string(c.get(runtime, "run")(c.array_merge(prefix, args))) + c.string("\n")));
      c.exit(0);
    }
    result = c.clone(selectEnvironment(contexts, c.get(input, "capabilities") ?? []));
    process.stdout.write(c.string(c.string(c.json_encode(c.entriesArray([["ok", true], ["result", result]]), c.JSON_THROW_ON_ERROR)) + c.string("\n")));
  } catch (error) {
    process.stdout.write(c.string(c.string(c.json_encode(c.entriesArray([["ok", false], ["event", "blocked"], ["error", error.message]]), c.JSON_INVALID_UTF8_SUBSTITUTE)) + c.string("\n")));
    c.exit(1);
  }
}
