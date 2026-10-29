'use strict';

const c = require("../../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };

/** Keep all tmux commands on the explicitly selected server. */
function borkLayoutTmux(context, args) {
  c.assertType(context, "array", "borkLayoutTmux.context");
  c.assertType(args, "array", "borkLayoutTmux.args");
  let flag, key, prefix;
  context = c.clone(context);
  args = c.clone(args);
  prefix = c.clone(["tmux"]);
  if (c.get(context, "socket") != null && c.get(context, "socket_path") != null) {
    throw new Error("Supply one tmux socket selector.");
  }
  for (const [_key, _value] of c.entries(c.entriesArray([["socket", "-L"], ["socket_path", "-S"]]))) {
    key = _key;
    flag = c.clone(_value);
    {
      if (c.get(context, key) != null) {
        prefix = c.clone(c.array_merge(prefix, [flag, require("../terminal.js").field(context, key)]));
      }
    }
  }
  return require("../terminal.js").execute(c.array_merge(prefix, args));
}
/** Inspect actual pane geometry, creation identity, focus and ownership. */
function borkLayoutTmuxSnapshot(context, coordinator) {
  c.assertType(context, "array", "borkLayoutTmuxSnapshot.context");
  c.assertType(coordinator, "string", "borkLayoutTmuxSnapshot.coordinator");
  let active, command, dead, focus, format, height, id, line, output, owner, panes, parts, pid, placement, session, width, window, x, y;
  context = c.clone(context);
  coordinator = c.clone(coordinator);
  format = "#{pane_id}|#{window_id}|#{session_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{pane_active}|#{pane_pid}|#{@bork-layout}|#{@bork-placement}|#{pane_current_command}|#{pane_dead}";
  output = c.clone(borkLayoutTmux(context, ["list-panes", "-t", coordinator, "-F", format]));
  panes = c.clone([]);
  focus = null;
  for (const [_key, _value] of c.entries(c.explode("\n", output))) {
    line = c.clone(_value);
    {
      parts = c.clone(c.explode("|", line));
      if (!c.equal(c.count(parts), 13) || !c.truth(c.preg_match("/^%[0-9]+$/D", c.get(parts, 0)))) {
        throw new Error("Cannot verify tmux pane snapshot.");
      }
      [id, window, session, x, y, width, height, active, pid, owner, placement, command, dead] = c.clone(parts);
      c.set(panes, [id], "=", c.entriesArray([["id", id], ["window", window], ["session", session], ["x", c.integer(x)], ["y", c.integer(y)], ["width", c.integer(width)], ["height", c.integer(height)], ["pid", c.integer(pid)], ["owner", owner], ["placement", placement], ["command", command], ["dead", c.equal(dead, "1")]]));
      if (c.equal(active, "1")) {
        focus = c.clone(id);
      }
    }
  }
  if (!(c.get(panes, coordinator) != null) || c.equal(focus, null)) {
    throw new Error("Recorded coordinator or focus is missing from its original tmux window.");
  }
  return c.entriesArray([["panes", panes], ["focus", focus]]);
}
/** Resolve installed split support without creating a pane. */
function borkLayoutTmuxCapabilities(context) {
  c.assertType(context, "array", "borkLayoutTmuxCapabilities.context");
  let command, commands;
  context = c.clone(context);
  commands = c.clone(borkLayoutTmux(context, ["list-commands"]));
  for (const [_key, _value] of c.entries(["split-window", "respawn-pane", "list-panes", "kill-pane"])) {
    command = c.clone(_value);
    {
      if (!c.str_contains(commands, command)) {
        throw new Error(c.string("Missing tmux capability: ") + c.string(command));
      }
    }
  }
  if (!c.truth(c.preg_match("/split-window[^\\n]*\\[-[^\\]]*d/", commands))) {
    throw new Error("tmux lacks background split support.");
  }
  return c.entriesArray([["version", borkLayoutTmux(context, ["-V"])], ["commands_sha256", c.hash("sha256", commands)]]);
}
/** Split only the recorded parent, using returned identity and detached focus. */
function borkLayoutTmuxSplit(record, operation) {
  c.assertType(record, "array", "borkLayoutTmuxSplit.record");
  c.assertType(operation, "array", "borkLayoutTmuxSplit.operation");
  let context, id, parent;
  record = c.clone(record);
  operation = c.clone(operation);
  context = c.clone(c.get(record, "context"));
  parent = c.clone(c.get(record, "resources", c.get(operation, "parent"), "id"));
  id = c.clone(borkLayoutTmux(context, ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", parent, c.equal(c.get(operation, "direction"), "right") ? "-h" : "-v", "-l", c.string(c.get(operation, "size")), "-c", c.get(record, "cwd"), "exec /bin/sh"]));
  if (!c.truth(c.preg_match("/^%[0-9]+$/D", id))) {
    throw new Error("Split response lacks a unique tmux pane ID; reconcile pending intent.");
  }
  borkLayoutTmux(context, ["set-option", "-p", "-t", id, "@bork-layout", c.get(record, "run_id")]);
  borkLayoutTmux(context, ["set-option", "-p", "-t", id, "@bork-placement", c.get(operation, "new")]);
  return id;
}
module.exports = {
  borkLayoutTmux,
  borkLayoutTmuxSnapshot,
  borkLayoutTmuxCapabilities,
  borkLayoutTmuxSplit
};
