'use strict';

const c = require("../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };

/** Limit recovered process data to the terminal drivers' documented caller identity. */
function terminalContextKeys() {
  return ["HC_TERMINAL_ID", "HC_SESSION", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SOCKET_PATH", "TMUX", "TMUX_PANE", "STY", "WINDOW", "SCREENDIR"];
}
/** Read one same-user interactive Codex frontend without retaining other variables. */
function terminalFrontend(directory, cwd, owner) {
  c.assertType(directory, "string", "terminalFrontend.directory");
  c.assertType(cwd, "string", "terminalFrontend.cwd");
  c.assertType(owner, "int", "terminalFrontend.owner");
  let args, command, entry, environment, fields, pair, raw, stat;
  directory = c.clone(directory);
  cwd = c.clone(cwd);
  owner = c.clone(owner);
  if (!c.equal(c.fileowner(directory), owner) || !c.equal(c.realpath(c.string(directory) + c.string("/cwd")), cwd) || !c.equal(c.basename(c.string(c.realpath(c.string(directory) + c.string("/exe")))), "codex")) {
    return null;
  }
  command = c.clone(c.file_get_contents(c.string(directory) + c.string("/cmdline")));
  stat = c.clone(c.file_get_contents(c.string(directory) + c.string("/stat")));
  if (c.equal(command, false) || c.equal(stat, false)) {
    return null;
  }
  args = c.clone(c.explode("\u0000", c.rtrim(command, "\u0000")));
  /* Daemons and noninteractive workers cannot identify an invoking terminal. */
  if (!c.truth(c.get(require("./provider-command.js").providerCommandMode(args), "interactive"))) {
    return null;
  }
  fields = c.clone(c.preg_split("/\\s+/", c.substr(stat, c.add(c.integer(c.strrpos(stat, ")")), 2))));
  if (!(c.get(fields, 19) != null) || !c.ctype_digit(c.get(fields, 19))) {
    return null;
  }
  raw = c.clone(c.file_get_contents(c.string(directory) + c.string("/environ")));
  if (c.equal(raw, false)) {
    throw new Error("Cannot inspect the matching Codex frontend environment; retry outside the sandbox.");
  }
  environment = c.clone([]);
  for (const [_key, _value] of c.entries(c.explode("\u0000", raw))) {
    entry = c.clone(_value);
    {
      pair = c.clone(c.explode("=", entry, 2));
      if (c.equal(c.count(pair), 2) && c.in_array(c.get(pair, 0), terminalContextKeys(), true)) {
        c.set(environment, [c.get(pair, 0)], "=", c.get(pair, 1));
      }
    }
  }
  return c.entriesArray([["pid", c.integer(c.basename(directory))], ["start_time", c.get(fields, 19)], ["environment", environment]]);
}
/** Resolve a terminal caller only when the local frontend is unique. */
function recoverTerminalFrontend(root, cwd, owner, expected) {
  c.assertType(root, "string", "recoverTerminalFrontend.root");
  c.assertType(cwd, "string", "recoverTerminalFrontend.cwd");
  c.assertType(owner, "int", "recoverTerminalFrontend.owner");
  c.assertType(expected, "?string", "recoverTerminalFrontend.expected");
  let candidate, candidates, directory, environment, hasContext, reported;
  root = c.clone(root);
  cwd = c.clone(cwd);
  owner = c.clone(owner);
  expected = c.clone(expected);
  candidates = c.clone([]);
  for (const [_key, _value] of c.entries(c.truth(c.glob(c.string(root) + c.string("/[0-9]*"), c.GLOB_ONLYDIR)) ? c.glob(c.string(root) + c.string("/[0-9]*"), c.GLOB_ONLYDIR) : [])) {
    directory = c.clone(_value);
    {
      candidate = c.clone(terminalFrontend(directory, cwd, owner));
      if (!c.equal(candidate, null)) {
        c.append(candidates, [], candidate);
      }
    }
  }
  hasContext = c.clone(c.array_filter(candidates, function (candidate) {
    candidate = c.clone(candidate);
    return !c.equal(c.get(candidate, "environment"), []);
  }));
  if (c.equal(expected, null) && c.equal(hasContext, [])) {
    return null;
  }
  environment = c.clone(c.get(candidates, 0, "environment") ?? []);
  reported = c.clone(c.equal(expected, null) ? !c.equal(environment, []) : c.equal(expected, "herdr") ? c.equal(c.get(environment, "HERDR_ENV") ?? null, "1") : !!c.truth(c.get(environment, (_match => c.equal(_match, "hc") ? "HC_TERMINAL_ID" : c.equal(_match, "screen") ? "STY" : "TMUX")(expected))));
  if (!c.equal(c.count(candidates), 1) || !c.truth(reported)) {
    throw new Error(c.string(c.string("Cannot uniquely resolve the reported ") + c.string(expected ?? "terminal")) + c.string(" caller: expected one same-user Codex frontend in this working directory with terminal context. Retry outside the sandbox or run Codex with --no-daemon in the invoking pane."));
  }
  return c.get(candidates, 0);
}
/** Bind discovery and later terminal commands to the same verified caller context. */
function environmentRuntime(expected) {
  c.assertType(expected, "?string", "environmentRuntime.expected");
  let cwd, environment, frontend, owner, run, runtime, signals;
  expected = c.clone(expected);
  run = require("./environment.js").environmentCommand;
  runtime = c.clone(c.entriesArray([["env", c.getenv], ["run", run], ["ancestor", function (pid) {
    pid = c.clone(pid);
    return require("./environment.js").environmentAncestor(pid, run);
  }], ["frontend", null]]));
  signals = c.clone(c.array_filter(c.array_map("getenv", c.array_diff(terminalContextKeys(), ["SCREENDIR", "HC_SESSION"])), function (value) {
    value = c.clone(value);
    return !c.equal(value, false) && !c.equal(value, "");
  }));
  if (!c.in_array(expected, [null, "hc", "herdr", "tmux", "screen"], true) || !c.equal(signals, []) || c.equal(expected, null) && !c.truth(c.getenv("CODEX_THREAD_ID"))) {
    return runtime;
  }
  if (!c.is_dir("/proc/self")) {
    if (c.equal(expected, null)) {
      return runtime;
    }
    throw new Error("Detached terminal caller recovery needs local procfs; run discovery in the invoking terminal.");
  }
  cwd = c.clone(c.realpath(c.getcwd()));
  owner = c.clone(c.fileowner("/proc/self"));
  frontend = c.clone(recoverTerminalFrontend("/proc", cwd, owner, expected));
  if (c.equal(frontend, null)) {
    return runtime;
  }
  environment = c.clone(c.array_replace(c.getenv(), c.get(frontend, "environment")));
  run = function (args) {
    let current;
    args = c.clone(args);
    current = c.clone(recoverTerminalFrontend("/proc", cwd, owner, expected));
    if (!c.equal(current, frontend)) {
      throw new Error("Terminal frontend identity changed; reconcile before retrying.");
    }
    return require("./environment.js").environmentCommand(args, environment);
  };
  return c.entriesArray([["env", function (key) {
    key = c.clone(key);
    return c.get(environment, key) ?? false;
  }], ["run", run], ["ancestor", function (pid) {
    pid = c.clone(pid);
    return require("./environment.js").environmentAncestor(pid, run, c.get(frontend, "pid"));
  }], ["frontend", c.entriesArray([["pid", c.get(frontend, "pid")], ["start_time", c.get(frontend, "start_time")], ["cwd", cwd], ["source", "same-user-cwd"]])]]);
}
module.exports = {
  terminalContextKeys,
  terminalFrontend,
  recoverTerminalFrontend,
  environmentRuntime
};
