'use strict';

const c = require("../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };
let error, input, mode, path, result;

/** Call tmux on the selected socket, supporting isolated test servers. */
function tmux(data, args) {
  c.assertType(data, "array", "tmux.data");
  c.assertType(args, "array", "tmux.args");
  let prefix;
  data = c.clone(data);
  args = c.clone(args);
  prefix = c.clone(["tmux"]);
  if (c.get(data, "socket_path") != null && c.get(data, "socket") != null) {
    throw new Error("Supply either socket_path or a named socket, not both.");
  }
  if (c.get(data, "socket_path") != null) {
    prefix = c.clone(c.array_merge(prefix, ["-S", require("./terminal.js").field(data, "socket_path")]));
  } else if (c.get(data, "socket") != null) {
    prefix = c.clone(c.array_merge(prefix, ["-L", require("./terminal.js").field(data, "socket")]));
  }
  return require("./terminal.js").execute(c.array_merge(prefix, args));
}
/** Launch one role session, retaining its pane after process exit. */
function launch(data, inputPath) {
  c.assertType(data, "array", "launch.data");
  c.assertType(inputPath, "string", "launch.inputPath");
  let bootstrap, cwd, job, layout, name, pane, placement, role, runner, session, shell;
  data = c.clone(data);
  inputPath = c.clone(inputPath);
  cwd = c.clone(require("./terminal.js").field(data, "cwd"));
  if (!c.is_dir(cwd)) {
    throw new Error("Working directory missing.");
  }
  role = c.clone(require("./terminal.js").field(data, "role"));
  if (!c.in_array(role, ["master", "review", "fix"], true)) {
    throw new Error("Only master, review or fix sessions may be launched.");
  }
  job = c.clone(require("./terminal.js").readInput(require("./terminal.js").field(data, "job")));
  require("./terminal.js").validateJob(job);
  shell = c.clone(c.get(data, "shell") ?? "posix");
  bootstrap = c.clone(require("./terminal.js").terminalCommand([c.NODE_BINARY, "-e", "setTimeout(() => {}, 60000);"], shell));
  runner = c.clone(require("./terminal.js").runnerCommand(inputPath, shell));
  name = c.clone(require("./terminal.js").field(data, "session_name"));
  if (!c.truth(c.preg_match("/^[a-zA-Z0-9_-]+$/", name))) {
    throw new Error("Unsafe session name.");
  }
  if (c.get(data, "layout_record") != null) {
    layout = c.clone(require("./terminal.js").readInput(require("./terminal.js").field(data, "layout_record")));
    if (!c.equal(c.get(layout, "driver"), "tmux") || !c.equal(c.get(layout, "context"), c.array_intersect_key(data, c.array_flip(["socket", "socket_path"])))) {
      throw new Error("Launch socket does not match its recorded layout.");
    }
    placement = c.clone(require("./layout.js").borkLayoutAction("claim", c.entriesArray([["record", c.get(data, "layout_record")], ["role", role], ["slot", c.get(data, "slot") ?? null], ["target_id", require("./terminal.js").field(data, "target_id")], ["task_id", require("./terminal.js").field(data, "task_id")]])));
    if (!c.get(placement, "id")) throw new Error("Visual admission is waiting or blocked; retain capacity result before launching a worker.");
    pane = c.clone(c.get(placement, "id"));
  } else {
    /* Retain standalone and already-approved legacy launch compatibility. */
    pane = c.clone(tmux(data, ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", name, "-c", cwd, bootstrap]));
  }
  tmux(data, ["set-option", "-p", "-t", pane, "remain-on-exit", "on"]);
  tmux(data, ["set-option", "-p", "-t", pane, "@bork-role", role]);
  tmux(data, ["select-pane", "-t", pane, "-T", c.string("bork-") + c.string(role)]);
  if (!(c.get(data, "layout_record") != null)) {
    tmux(data, ["set-option", "-w", "-t", pane, "pane-border-status", "top"]);
    tmux(data, ["set-option", "-w", "-t", pane, "pane-border-format", "#{pane_title}"]);
  }
  session = c.clone(tmux(data, ["display-message", "-p", "-t", pane, "#{session_name}"]));
  tmux(data, ["respawn-pane", "-k", "-t", pane, "-c", cwd, runner]);
  return c.entriesArray([["session", session], ["pane", pane], ["role", role], ["layout_record", c.get(data, "layout_record") ?? null], ["slot", c.get(data, "slot") ?? null]]);
}
module.exports = {
  tmux,
  launch
};
if (require.main === module) {
  try {
    mode = c.clone(c.get(argv, 1) ?? "");
    path = c.clone(c.realpath(c.get(argv, 2) ?? ""));
    if (c.equal(path, false)) {
      throw new Error("Usage: node tmux.js schedule|command|launch|run input.json");
    }
    input = c.clone(require("./terminal.js").readInput(path));
    if (c.equal(mode, "run")) {
      c.exit(require("./terminal.js").runPane(input));
    }
    if (c.equal(mode, "schedule")) {
      result = c.clone(require("./scheduler.js").schedule(input));
    } else if (c.equal(mode, "command")) {
      result = c.clone(c.entriesArray([["command", require("./terminal.js").runnerCommand(path, require("./terminal.js").field(input, "shell"))]]));
    } else if (c.equal(mode, "launch")) {
      result = c.clone(launch(input, path));
    } else {
      throw new Error("Unknown mode.");
    }
    process.stdout.write(c.string(c.string(c.json_encode(c.entriesArray([["ok", true], ["result", result]]), c.JSON_THROW_ON_ERROR)) + c.string("\n")));
  } catch (error) {
    process.stdout.write(c.string(c.string(c.json_encode(c.entriesArray([["ok", false], ["event", "blocked"], ["error", error.message]]), c.JSON_INVALID_UTF8_SUBSTITUTE)) + c.string("\n")));
    c.exit(1);
  }
}
