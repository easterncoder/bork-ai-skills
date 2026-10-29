'use strict';

const c = require("../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };

/** Verify the exact live Screen window against its ancestral process environment. */
function detectScreenContext(env, run, ancestor) {
  c.assertType(env, "callable", "detectScreenContext.env");
  env = c.callable(env);
  c.assertType(run, "callable", "detectScreenContext.run");
  run = c.callable(run);
  c.assertType(ancestor, "callable", "detectScreenContext.ancestor");
  ancestor = c.callable(ancestor);
  env = c.callable(env);
  run = c.callable(run);
  ancestor = c.callable(ancestor);
  let child, line, match, raw, reply, server, session, shell, window;
  env = c.clone(env);
  run = c.clone(run);
  ancestor = c.clone(ancestor);
  session = c.clone(env("STY"));
  window = c.clone(env("WINDOW"));
  if ((c.equal(session, false) || c.equal(session, "")) && (c.equal(window, false) || c.equal(window, ""))) {
    return c.entriesArray([["active", false]]);
  }
  if (!c.is_string(session) || !c.truth(c.preg_match("/^([1-9][0-9]*)\\.[^\\s\\/]+$/D", session, _m => {
    match = _m;
  })) || !c.is_string(window) || !c.ctype_digit(window)) {
    throw new Error("Explicit Screen context is incomplete; restore STY and WINDOW in the live window.");
  }
  server = c.clone(c.integer(c.get(match, 1)));
  if (!c.truth(ancestor(server))) {
    throw new Error("Explicit Screen session belongs to another process; reconcile membership.");
  }
  reply = c.clone(run(["screen", "-S", session, "-p", window, "-Q", "number"]));
  if (!c.truth(c.preg_match(c.string(c.string("/^") + c.string(c.preg_quote(window, "/"))) + c.string(" \\(/"), reply))) {
    throw new Error("Explicit Screen window is stale.");
  }
  /* Screen exposes no window PID query; procfs binds the window to its live child. */
  shell = null;
  for (const [_key, _value] of c.entries(c.explode("\n", run(["ps", "-eo", "pid=,ppid="])))) {
    line = c.clone(_value);
    {
      if (!c.truth(c.preg_match("/^\\s*(\\d+)\\s+(\\d+)\\s*$/", line, _m => {
        child = _m;
      })) || !c.equal(c.integer(c.get(child, 2)), server) || !c.truth(ancestor(c.integer(c.get(child, 1))))) {
        continue;
      }
      raw = c.clone(c.file_get_contents(c.string(c.string("/proc/") + c.string(c.get(child, 1))) + c.string("/environ")));
      if (!c.equal(raw, false) && c.in_array(c.string("STY=") + c.string(session), c.explode("\u0000", raw), true) && c.in_array(c.string("WINDOW=") + c.string(window), c.explode("\u0000", raw), true)) {
        shell = c.clone(c.integer(c.get(child, 1)));
      }
    }
  }
  if (c.equal(shell, null)) {
    throw new Error("Cannot verify Screen window ancestry and environment via local procfs; reconcile caller context.");
  }
  return c.entriesArray([["active", true], ["session_id", session], ["pane_id", window], ["socket", session], ["shell_pid", shell], ["socket_dir", c.truth(env("SCREENDIR")) ? env("SCREENDIR") : null]]);
}
module.exports = {
  detectScreenContext
};
