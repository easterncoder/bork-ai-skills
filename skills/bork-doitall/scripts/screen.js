'use strict';

const c = require("../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };
let error, input, mode, path, result;

/** Preserve a verified custom socket directory across detached tool boundaries. */
function screenExecute(data, args, codes = [0]) {
  c.assertType(data, "array", "screenExecute.data");
  c.assertType(args, "array", "screenExecute.args");
  c.assertType(codes, "array", "screenExecute.codes");
  let directory, environment;
  data = c.clone(data);
  args = c.clone(args);
  codes = c.clone(codes);
  environment = null;
  if (c.get(data, "socket_dir") != null) {
    directory = c.clone(require("./terminal.js").field(data, "socket_dir"));
    if (!c.is_dir(directory) || !c.equal(c.realpath(directory), directory)) {
      throw new Error("Screen socket directory must be an existing absolute directory.");
    }
    environment = c.clone(c.array_replace(c.getenv(), c.entriesArray([["SCREENDIR", directory]])));
  }
  return require("./terminal.js").execute(args, codes, environment);
}
/** Address one exact recorded Screen session and window without shell interpolation. */
function screenCommand(data, args) {
  c.assertType(data, "array", "screenCommand.data");
  c.assertType(args, "array", "screenCommand.args");
  let session, window;
  data = c.clone(data);
  args = c.clone(args);
  session = c.clone(require("./terminal.js").field(data, "session"));
  window = c.clone(require("./terminal.js").field(data, "pane"));
  if (!c.truth(c.preg_match("/^[1-9][0-9]*\\.[a-zA-Z0-9_-]+$/D", session)) || !c.ctype_digit(window)) {
    throw new Error("Invalid recorded Screen identity.");
  }
  return screenExecute(data, c.array_merge(["screen", "-S", session, "-p", window], args));
}
/** List local sessions while distinguishing an empty server from command failure. */
function screenSessions(data) {
  c.assertType(data, "array", "screenSessions.data");
  let output;
  data = c.clone(data);
  output = c.clone(screenExecute(data, ["screen", "-ls"], [0, 1]));
  if (!c.str_contains(output, "No Sockets found") && !c.truth(c.preg_match("/[0-9]+ Sockets? in /", output))) {
    throw new Error("Cannot establish the local Screen session inventory.");
  }
  return output;
}
/** Launch one isolated role session with retained dead windows and shared runner evidence. */
function launchScreen(data, path) {
  c.assertType(data, "array", "launchScreen.data");
  c.assertType(path, "string", "launchScreen.path");
  let command, config, cwd, handle, identity, layout, matches, name, placement, role, sessions;
  data = c.clone(data);
  path = c.clone(path);
  if (c.get(data, "layout_record") != null) {
    require("./terminal.js").validateJob(require("./terminal.js").readInput(require("./terminal.js").field(data, "job")));
    layout = c.clone(require("./terminal.js").readInput(require("./terminal.js").field(data, "layout_record")));
    if (!c.equal(c.get(layout, "driver"), "screen")) {
      throw new Error("Screen launch requires its recorded Screen layout.");
    }
    placement = c.clone(require("./layout.js").borkLayoutAction("claim", c.array_replace(data, c.entriesArray([["record", c.get(data, "layout_record")]]))));
    command = c.clone(require("./terminal.js").terminalCommand([c.NODE_BINARY, c.string(__dirname) + c.string("/tmux.js"), "run", path], "posix"));
    require("./layout-adapters/screen.js").borkLayoutScreen(c.get(layout, "context"), ["-p", c.get(placement, "id"), "-X", "stuff", c.string(command) + c.string("\n")]);
    return c.entriesArray([["session", c.get(layout, "context", "session")], ["pane", c.get(placement, "id")], ["role", c.get(data, "role")], ["socket_dir", c.get(layout, "context", "socket_dir") ?? null], ["layout_record", c.get(data, "layout_record")]]);
  }
  role = c.clone(require("./terminal.js").field(data, "role"));
  name = c.clone(require("./terminal.js").field(data, "session_name"));
  cwd = c.clone(require("./terminal.js").field(data, "cwd"));
  if (!c.in_array(role, ["master", "review", "fix"], true) || !c.truth(c.preg_match("/^[a-zA-Z0-9_-]+$/D", name)) || !c.is_dir(cwd)) {
    throw new Error("Invalid Screen role, session name or working directory.");
  }
  require("./terminal.js").validateJob(require("./terminal.js").readInput(require("./terminal.js").field(data, "job")));
  if (c.truth(c.preg_match(c.string(c.string("/^\\s*[1-9][0-9]*\\.") + c.string(c.preg_quote(name, "/"))) + c.string("\\s/m"), screenSessions(data)))) {
    throw new Error("Screen session name already exists; reconcile ownership before launch.");
  }
  config = c.clone(c.string(path) + c.string(".screenrc"));
  try {
    require('node:fs').writeFileSync(config, "startup_message off\nzombie kr\ndefscrollback 10000\n", {
      flag: 'wx',
      mode: 0o600
    });
  } catch {
    throw new Error('Screen configuration exists; reconcile the prior launch.');
  }
  /* -m creates a separate session even when invoked from another Screen window. */
  screenExecute(data, ["screen", "-dmS", name, "-c", config, "-t", c.string("bork-") + c.string(role), c.NODE_BINARY, c.string(__dirname) + c.string("/tmux.js"), "run", path]);
  sessions = c.clone(screenSessions(data));
  c.preg_match_all(c.string(c.string("/^\\s*([1-9][0-9]*\\.") + c.string(c.preg_quote(name, "/"))) + c.string(")\\s/m"), sessions, _m => {
    matches = _m;
  });
  if (!c.equal(c.count(c.get(matches, 1)), 1)) {
    throw new Error("Screen launch identity is ambiguous; reconcile before retrying.");
  }
  identity = c.clone(c.entriesArray([["session", c.get(matches, 1, 0)], ["pane", "0"], ["role", role], ["config", config], ["socket_dir", c.get(data, "socket_dir") ?? null]]));
  screenCommand(identity, ["-Q", "number"]);
  return identity;
}
module.exports = {
  screenExecute,
  screenCommand,
  screenSessions,
  launchScreen
};
if (require.main === module) {
  try {
    path = c.clone(c.realpath(c.get(argv, 2) ?? ""));
    if (c.equal(path, false)) {
      throw new Error("Usage: node screen.js launch|inspect|capture|interrupt|close input.json");
    }
    input = c.clone(require("./terminal.js").readInput(path));
    mode = c.clone(c.get(argv, 1) ?? "");
    result = c.clone((_match => c.equal(_match, "launch") ? launchScreen(input, path) : c.equal(_match, "inspect") ? c.entriesArray([["window", screenCommand(input, ["-Q", "windows"])]]) : c.equal(_match, "capture") ? c.entriesArray([["output", screenCommand(input, ["-X", "hardcopy", "-h", require("./terminal.js").field(input, "output")])]]) : c.equal(_match, "interrupt") ? c.entriesArray([["output", screenCommand(input, ["-X", "stuff", "\u0003"])]]) : c.equal(_match, "close") ? c.get(input, "layout_record") != null ? c.fail(new Error("Shared layout slots remain open; accept the stopped result, release the slot, then use owned layout cleanup.")) : c.entriesArray([["output", screenCommand(input, ["-X", "quit"])]]) : c.fail(new Error("Unknown Screen action.")))(mode));
    process.stdout.write(c.string(c.string(c.json_encode(c.entriesArray([["ok", true], ["result", result]]), c.JSON_THROW_ON_ERROR)) + c.string("\n")));
  } catch (error) {
    process.stdout.write(c.string(c.string(c.json_encode(c.entriesArray([["ok", false], ["event", "blocked"], ["error", error.message]]), c.JSON_INVALID_UTF8_SUBSTITUTE)) + c.string("\n")));
    c.exit(1);
  }
}
