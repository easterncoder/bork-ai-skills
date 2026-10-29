'use strict';

const c = require("../../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };

/** Execute a Screen control through one verified attached display's exact tty. */
function borkLayoutScreen(context, args, confirm = true) {
  c.assertType(context, "array", "borkLayoutScreen.context");
  c.assertType(args, "array", "borkLayoutScreen.args");
  c.assertType(confirm, "bool", "borkLayoutScreen.confirm");
  let code, command, deadline, environment, error, errors, match, mutation, nonce, output, pipes, prefix, process, query, quoted, session, target, tty, windows;
  context = c.clone(context);
  args = c.clone(args);
  confirm = c.clone(confirm);
  mutation = c.clone(c.array_search("-X", args, true));
  if (c.truth(confirm) && !c.equal(mutation, false) && !c.equal(c.get(args, c.add(mutation, 1)) ?? "", "echo")) {
    prefix = c.clone(c.array_slice(args, 0, mutation));
    command = c.clone(c.array_slice(args, c.add(mutation, 1)));
    nonce = c.clone(c.string("BORKCONTROL") + c.string(c.bin2hex(c.random_bytes(10))));
    if (c.equal(c.get(command, 0) ?? "", "kill")) {
      target = c.clone(c.get(prefix, c.add(c.array_search("-p", prefix, true), 1)) ?? null);
      if (!c.is_string(target) || !c.ctype_digit(target)) {
        throw new Error("Screen window removal requires an exact owned window.");
      }
      borkLayoutScreen(context, args, false);
      deadline = c.clone(c.add(c.microtime(true), 3));
      do {
        windows = c.clone(borkLayoutScreen(context, ["-Q", "windows", "%n|%f;"], false));
        if (!c.truth(c.preg_match(c.string(c.string("/(?:^|;)\\s*") + c.string(c.preg_quote(target, "/"))) + c.string("\\|/"), windows))) {
          return "";
        }
        c.usleep(10000);
      } while (c.microtime(true) < deadline);
      throw new Error("Screen did not confirm owned window removal; retain pending intent.");
    }
    query = c.clone(c.equal(c.get(command, 0) ?? "", "layout") && c.in_array(c.get(command, 1) ?? "", ["number", "show"], true) && c.equal(c.count(command), 2));
    if (c.truth(query)) {
      borkLayoutScreen(context, ["-X", "echo", nonce], false);
      borkLayoutScreenMessage(context, function (message) {
        message = c.clone(message);
        return c.equal(message, nonce);
      });
      borkLayoutScreen(context, args, false);
      return borkLayoutScreenMessage(context, function (message) {
        message = c.clone(message);
        return !c.equal(message, nonce);
      });
    }
    quoted = c.clone(c.array_map(function (arg) {
      arg = c.clone(arg);
      if (c.str_contains(arg, "\u0000")) {
        throw new Error("Screen control contains a null byte.");
      }
      return c.string(c.string("\"") + c.string(c.strtr(arg, c.entriesArray([["\\", "\\\\"], ["\"", "\\\""], ["$", "\\$"], ["^", "\\^"], ["#", "\\#"], ["\n", "\\n"], ["\r", "\\r"]])))) + c.string("\"");
    }, command));
    borkLayoutScreen(context, c.array_merge(prefix, ["-X", "eval", c.implode(" ", quoted), c.string("echo ") + c.string(nonce)]), false);
    try {
      borkLayoutScreenMessage(context, function (message) {
        message = c.clone(message);
        return c.equal(message, nonce);
      });
    } catch (error) {
      throw new Error(c.string(c.string(error.message) + c.string(" Control: ")) + c.string(c.implode(" ", c.array_slice(command, 0, 2))));
    }
    return "";
  }
  session = c.clone(require("../terminal.js").field(context, "session"));
  if (!c.truth(c.preg_match("/^([1-9][0-9]*)\\.[a-zA-Z0-9_-]+$/D", session, _m => {
    match = _m;
  }))) {
    throw new Error("Screen needs an exact local server PID.session identity.");
  }
  tty = c.clone(c.get(context, "display_tty") ?? c.get(context, "window_tty") ?? null);
  if (!c.is_string(tty) || !c.truth(c.preg_match("#^/dev/(pts/[0-9]+|tty[a-zA-Z0-9]+)$#D", tty)) || !c.is_readable(tty)) {
    throw new Error("Screen requires a verified readable display or origin window tty.");
  }
  environment = c.clone(c.getenv());
  if (c.get(context, "socket_dir") != null) {
    c.set(environment, ["SCREENDIR"], "=", require("../terminal.js").field(context, "socket_dir"));
  }
  const fs = require('node:fs');
  const descriptor = fs.openSync(tty, 'r');
  let result;
  try {
    const query = args.includes('-Q') && !args.includes('-X');
    for (let attempt = 0; attempt < (query ? 5 : 1); attempt++) {
      result = c.processResult(['screen', '-S', session, ...args], {
        env: c.object(environment),
        timeout: query ? 1000 : 5000,
        /* Screen may pass stderr to newly created windows; do not wait for their pipe closure. */
        stdio: [descriptor, 'pipe', 'ignore']
      });
      if (result.error?.code !== 'ETIMEDOUT') break;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (result.error?.code === 'ETIMEDOUT') throw new Error('Screen control timed out; retain pending intent and reconcile without replay. Request: ' + args.join(' '));
  if (result.error) throw new Error('Cannot address recorded Screen display.');
  if (result.code !== 0) throw new Error('Screen control failed; retain mutation intent before reconciliation.');
  /* Preserve the polling interval between controls while Screen updates its display. */
  c.usleep(10000);
  /* Screen can prefix a valid query reply with its dead-client notice after a timed-out read. */
  return (args.includes('-Q') ? result.output.replace(/^(?:Remove dead screens with 'screen -wipe'\.\s*)+/, '') : result.output).trim();
}

/** Read the inherited controlling tty only when stdin is a character device. */
function screenStdinTty() {
  const fs = require('node:fs');
  try {
    return fs.fstatSync(0).isCharacterDevice() ? fs.readlinkSync('/proc/self/fd/0') : false;
  } catch {
    return false;
  }
}

/** Resolve exact display membership without attaching or changing focus. */
function borkLayoutScreenContext(context, coordinator) {
  c.assertType(context, "array", "borkLayoutScreenContext.context");
  c.assertType(coordinator, "string", "borkLayoutScreenContext.coordinator");
  let candidate, candidates, fd, flags, found, identity, match, matches, nonce, number, pid, probe, session, stat, target;
  context = c.clone(context);
  coordinator = c.clone(coordinator);
  if (!c.ctype_digit(coordinator)) {
    throw new Error("Screen coordinator must be a measured window number.");
  }
  session = c.clone(require("../terminal.js").field(context, "session"));
  if (!c.truth(c.preg_match("/^([1-9][0-9]*)\\.[a-zA-Z0-9_-]+$/D", session, _m => {
    match = _m;
  }))) {
    throw new Error("Screen session identity must include its local server PID.");
  }
  pid = c.clone(c.get(match, 1));
  stat = c.clone(c.file_get_contents(c.string(c.string("/proc/") + c.string(pid)) + c.string("/stat")));
  if (c.equal(stat, false)) {
    throw new Error("Screen display discovery requires Linux procfs or a supported verified endpoint.");
  }
  identity = c.clone(c.get(c.explode(" ", c.substr(stat, c.add(c.strrpos(stat, ")"), 2))), 19));
  if (c.get(context, "server_start") != null && !c.equal(c.get(context, "server_start"), identity)) {
    throw new Error("Screen server PID was reused.");
  }
  c.set(context, ["server_start"], "=", identity);
  candidates = c.clone([]);
  for (const [_key, _value] of c.entries(c.truth(c.glob(c.string(c.string("/proc/") + c.string(pid)) + c.string("/fd/*"))) ? c.glob(c.string(c.string("/proc/") + c.string(pid)) + c.string("/fd/*")) : [])) {
    fd = c.clone(_value);
    {
      target = c.clone(c.readlink(fd));
      if (c.is_string(target) && c.truth(c.preg_match("#^/dev/pts/[0-9]+$#D", target))) {
        c.set(candidates, [target], "=", true);
      }
    }
  }
  if (c.get(context, "display_tty") != null) {
    if (!(c.get(candidates, c.get(context, "display_tty")) != null)) {
      throw new Error("Recorded display tty is no longer owned by this Screen server.");
    }
    return context;
  }
  c.set(context, ["window_tty"], "??=", c.truth(c.getenv("TTY")) ? c.getenv("TTY") : screenStdinTty());
  flags = c.clone(borkLayoutScreen(context, ["-Q", "windows", "%n|%f;"]));
  if (!c.truth(c.preg_match(c.string(c.string("/(?:^|;)\\s*") + c.string(c.preg_quote(coordinator, "/"))) + c.string("\\|([^;]*);/"), flags, _m => {
    found = _m;
  })) || c.str_contains(c.get(found, 1), "&")) {
    throw new Error("Coordinator window is absent or displayed more than once; preserve all displays.");
  }
  number = c.clone(borkLayoutScreen(context, ["-Q", "number"]));
  if (!c.str_starts_with(number, c.string(coordinator) + c.string(" "))) {
    throw new Error("Origin window tty does not identify the coordinator.");
  }
  nonce = c.clone(c.string("BORKDISPLAY") + c.string(c.bin2hex(c.random_bytes(12))));
  borkLayoutScreen(context, ["-X", "echo", nonce]);
  matches = c.clone([]);
  for (const [_key, _value] of c.entries(c.array_keys(candidates))) {
    candidate = c.clone(_value);
    {
      probe = c.clone(c.array_replace(context, c.entriesArray([["display_tty", candidate]])));
      if (c.equal(borkLayoutScreen(probe, ["-Q", "lastmsg"]), nonce)) {
        c.append(matches, [], candidate);
      }
    }
  }
  if (!c.equal(c.count(matches), 1)) {
    throw new Error("Screen display nonce did not resolve exactly one attached display.");
  }
  c.set(context, ["display_tty"], "=", c.get(matches, 0));
  return context;
}
/** Verify the installed control surface before any region mutation. */
function borkLayoutScreenCapabilities(context = []) {
  c.assertType(context, "array", "borkLayoutScreenCapabilities.context");
  context = c.clone(context);
  return c.entriesArray([["supported", true], ["version", require("../terminal.js").execute(["screen", "--version"])], ["scope", "Attached local display, unique displayed windows, measured layout and exact tty routing."], ["preflight_effect", "Automatic discovery updates only the owning display status message with a nonce."]]);
}
/** Replay the documented layout dump into an ordered abstract split tree. */
function borkLayoutScreenTopology(dump) {
  c.assertType(dump, "string", "borkLayoutScreenTopology.dump");
  let container, focus, id, leaves, line, newValue, nodes, offset, parent, type;
  dump = c.clone(dump);
  nodes = c.clone(c.entriesArray([[0, c.entriesArray([["type", "leaf"], ["parent", null]])]]));
  leaves = c.clone([0]);
  focus = 0;
  for (const [_key, _value] of c.entries(c.preg_split("/\\R/", c.trim(dump)))) {
    line = c.clone(_value);
    {
      if (c.equal(c.trim(line), "focus")) {
        focus = c.clone(c.add(focus, 1) % c.count(leaves));
        continue;
      }
      if (!c.in_array(c.trim(line), ["split", "split -v"], true)) {
        throw new Error(c.string("Unrecognized Screen layout dump command: ") + c.string(c.json_encode(line)));
      }
      type = c.clone(c.equal(c.trim(line), "split -v") ? "row" : "column");
      id = c.clone(c.get(leaves, focus));
      parent = c.clone(c.get(nodes, id, "parent"));
      newValue = c.clone(c.count(nodes));
      c.set(nodes, [newValue], "=", c.entriesArray([["type", "leaf"], ["parent", parent]]));
      if (!c.equal(parent, null) && c.equal(c.get(nodes, parent, "type"), type)) {
        offset = c.clone(c.array_search(id, c.get(nodes, parent, "children"), true));
        c.array_splice(c.get(nodes, parent, "children"), c.add(offset, 1), 0, [newValue]);
      } else {
        container = c.clone(c.count(nodes));
        c.set(nodes, [container], "=", c.entriesArray([["type", type], ["parent", parent], ["children", [id, newValue]]]));
        if (!c.equal(parent, null)) {
          offset = c.clone(c.array_search(id, c.get(nodes, parent, "children"), true));
          c.set(nodes, [parent, "children", offset], "=", container);
        }
        c.set(nodes, [id, "parent"], "=", container);
        c.set(nodes, [newValue, "parent"], "=", container);
      }
      c.array_splice(leaves, c.add(focus, 1), 0, [newValue]);
    }
  }
  return c.entriesArray([["nodes", nodes], ["leaves", leaves]]);
}
/** Compute region positions from topology and uniquely displayed PTY sizes. */
function borkLayoutScreenRect(nodes, id, measured, x, y, panes) {
  c.assertType(nodes, "array", "borkLayoutScreenRect.nodes");
  c.assertType(id, "int", "borkLayoutScreenRect.id");
  c.assertType(measured, "array", "borkLayoutScreenRect.measured");
  c.assertType(x, "int", "borkLayoutScreenRect.x");
  c.assertType(y, "int", "borkLayoutScreenRect.y");
  c.assertType(panes, "array", "borkLayoutScreenRect.panes");
  let child, height, index, node, pane, rect, width;
  nodes = c.clone(nodes);
  id = c.clone(id);
  measured = c.clone(measured);
  x = c.clone(x);
  y = c.clone(y);
  node = c.clone(c.get(nodes, id));
  if (c.equal(c.get(node, "type"), "leaf")) {
    pane = c.clone(c.get(measured, id));
    c.set(panes, [c.get(pane, "id")], "=", c.add(pane, c.entriesArray([["x", x], ["y", y]])));
    return pane;
  }
  width = 0;
  height = 0;
  for (const [_key, _value] of c.entries(c.get(node, "children"))) {
    index = _key;
    child = c.clone(_value);
    {
      rect = c.clone(borkLayoutScreenRect(nodes, child, measured, c.add(x, c.equal(c.get(node, "type"), "row") ? width : 0), c.add(y, c.equal(c.get(node, "type"), "column") ? height : 0), panes));
      if (c.equal(c.get(node, "type"), "row")) {
        width = c.add(width, c.add(c.get(rect, "width"), 1));
        height = c.clone(c.max(height, c.get(rect, "height")));
      } else {
        height = c.add(height, c.add(c.get(rect, "height"), 1));
        width = c.clone(c.max(width, c.get(rect, "width")));
      }
    }
  }
  return c.entriesArray([["width", width - (c.equal(c.get(node, "type"), "row") ? 1 : 0)], ["height", height - (c.equal(c.get(node, "type"), "column") ? 1 : 0)]]);
}
/** Traverse one exact display, restoring its original focus even when a gate fails. */
function borkLayoutScreenSnapshot(context, coordinator) {
  c.assertType(context, "array", "borkLayoutScreenSnapshot.context");
  c.assertType(coordinator, "string", "borkLayoutScreenSnapshot.coordinator");
  let dump, flags, focus, found, id, leaf, measured, panes, root, seen, size, topology;
  context = c.clone(context);
  coordinator = c.clone(coordinator);
  context = c.clone(borkLayoutScreenContext(context, coordinator));
  focus = c.clone(c.get(c.explode(" ", borkLayoutScreen(context, ["-Q", "number"]), 2), 0));
  dump = c.clone(c.tempnam(c.sys_get_temp_dir(), "bork-screen-dump-"));
  try {
    borkLayoutScreen(context, ["-X", "layout", "dump", dump]);
    topology = c.clone(borkLayoutScreenTopology(c.file_get_contents(dump)));
    flags = c.clone(borkLayoutScreen(context, ["-Q", "windows", "%n|%f;"]));
    if (c.str_contains(flags, "&")) {
      throw new Error("Screen has multiply displayed windows; preserve their canvas geometry.");
    }
    measured = c.clone([]);
    seen = [];
    borkLayoutScreen(context, ["-X", "focus", "top"]);
    for (const [_key, _value] of c.entries(c.get(topology, "leaves"))) {
      leaf = c.clone(_value);
      {
        id = c.clone(c.get(c.explode(" ", borkLayoutScreen(context, ["-Q", "number"]), 2), 0));
        if (!c.ctype_digit(id) || c.get(seen, id) != null) {
          throw new Error("Blank or duplicate Screen regions cannot be measured safely.");
        }
        c.set(seen, [id], "=", true);
        if (!c.truth(c.preg_match(c.string(c.string("/(?:^|;)\\s*") + c.string(c.preg_quote(id, "/"))) + c.string("\\|([^;]*);/"), flags, _m => {
          found = _m;
        })) || c.str_contains(c.get(found, 1), "&")) {
          throw new Error("Displayed Screen window is shared; resizing would affect another canvas.");
        }
        if (!c.truth(c.preg_match("#/\\(([0-9]+),([0-9]+)\\)#", borkLayoutScreen(context, ["-Q", "info"]), _m => {
          size = _m;
        }))) {
          throw new Error("Cannot measure Screen region terminal dimensions.");
        }
        c.set(measured, [leaf], "=", c.entriesArray([["id", id], ["width", c.integer(c.get(size, 1))], ["height", c.integer(c.get(size, 2))], ["window", c.get(context, "session")], ["session", c.get(context, "session")]]));
        borkLayoutScreen(context, ["-X", "focus", "next"]);
      }
    }
    root = c.clone(c.array_key_first(c.array_filter(c.get(topology, "nodes"), function (node) {
      node = c.clone(node);
      return c.equal(c.get(node, "parent"), null);
    })));
    panes = c.clone([]);
    borkLayoutScreenRect(c.get(topology, "nodes"), root, measured, 0, 0, panes);
    return c.entriesArray([["panes", panes], ["focus", focus], ["topology", topology], ["order", c.array_column(measured, "id")]]);
  } finally {
    c.unlink(dump);
    borkLayoutScreenFocus(context, focus, c.add(c.count(c.get(topology, "leaves") ?? []), 1));
  }
}
/** Focus a unique displayed window without changing any window assignment. */
function borkLayoutScreenFocus(context, id, limit = 100) {
  c.assertType(context, "array", "borkLayoutScreenFocus.context");
  c.assertType(id, "string", "borkLayoutScreenFocus.id");
  c.assertType(limit, "int", "borkLayoutScreenFocus.limit");
  let index;
  context = c.clone(context);
  id = c.clone(id);
  limit = c.clone(limit);
  borkLayoutScreen(context, ["-X", "focus", "top"]);
  for (index = 0; index < limit; index = c.add(index, 1)) {
    if (c.str_starts_with(borkLayoutScreen(context, ["-Q", "number"]), c.string(id) + c.string(" "))) {
      return;
    }
    borkLayoutScreen(context, ["-X", "focus", "next"]);
  }
  throw new Error("Recorded Screen region is no longer uniquely displayed.");
}
/** Save separate immutable backup and working layouts before changing regions. */
function borkLayoutScreenPrepare(record) {
  c.assertType(record, "array", "borkLayoutScreenPrepare.record");
  let autosave, context, layouts, match, original, saved, tag;
  record = c.clone(record);
  context = c.clone(c.get(record, "context"));
  original = c.clone(borkLayoutScreen(context, ["-X", "layout", "number"]));
  autosave = "Original layout autosave is untouched.";
  tag = c.clone(c.string("bork") + c.string(c.bin2hex(c.random_bytes(8))));
  layouts = c.clone(borkLayoutScreen(context, ["-X", "layout", "show"]));
  if (c.equal(original, "not on a layout") && !c.str_contains(layouts, "No layouts defined")) {
    throw new Error("Screen has saved layouts but no active layout; preserve them until restoration can retain the active pointer.");
  }
  c.set(record, ["screen"], "=", c.entriesArray([["backup", c.string(tag) + c.string("backup")], ["working", c.string(tag) + c.string("work")], ["original_layout", original], ["original_autosave", autosave]]));
  c.set(record, ["pending"], "=", c.entriesArray([["prepare_layouts", c.get(record, "screen")]]));
  require("../layout.js").borkLayoutWrite(c.get(record, "record"), record);
  borkLayoutScreen(context, ["-X", "layout", "save", c.get(record, "screen", "backup")]);
  borkLayoutScreen(context, ["-X", "layout", "autosave", "off"]);
  borkLayoutScreen(context, ["-X", "layout", "save", c.get(record, "screen", "working")]);
  borkLayoutScreen(context, ["-X", "layout", "autosave", "off"]);
  if (c.truth(c.preg_match("/^This is layout ([0-9]+) \\(/", original, _m => {
    match = _m;
  }))) {
    borkLayoutScreen(context, ["-X", "layout", "select", c.get(match, 1)]);
    saved = c.clone(borkLayoutScreenSnapshot(context, c.get(record, "coordinator")));
    borkLayoutScreen(context, ["-X", "layout", "select", c.get(record, "screen", "backup")]);
    borkLayoutScreen(context, ["-X", "layout", "select", c.get(record, "screen", "working")]);
    if (!c.equal(c.get(saved, "panes"), c.get(record, "original", "panes")) || !c.equal(c.get(saved, "focus"), c.get(record, "original", "focus"))) {
      borkLayoutScreen(context, ["-X", "layout", "select", c.get(record, "screen", "backup")]);
      throw new Error("Original Screen saved layout differs from live arrangement; original arrangement restored, retain journal for reconciliation.");
    }
  }
  c.set(record, ["pending"], "=", null);
  return record;
}
/** Create one ordinary shell placeholder in a new region of the same display. */
function borkLayoutScreenSplit(record, operation) {
  c.assertType(record, "array", "borkLayoutScreenSplit.record");
  c.assertType(operation, "array", "borkLayoutScreenSplit.operation");
  let context, id, oldId, pane, parent, pidfile, shell;
  record = c.clone(record);
  operation = c.clone(operation);
  context = c.clone(c.get(record, "context"));
  parent = c.clone(c.get(record, "resources", c.get(operation, "parent"), "id"));
  try {
    borkLayoutScreenFocus(context, parent);
    borkLayoutScreen(context, c.array_merge(["-X", "split"], c.equal(c.get(operation, "direction"), "right") ? ["-v"] : []));
    borkLayoutScreen(context, ["-X", "focus", "next"]);
    pidfile = c.clone(c.string(c.string(c.string(c.get(record, "record")) + c.string(".")) + c.string(c.str_replace(":", "-", c.get(operation, "new")))) + c.string(".pid"));
    if (c.file_exists(pidfile)) {
      throw new Error("Screen placeholder identity file exists; reconcile pending split.");
    }
    shell = c.clone(c.string(c.string("echo $$ > ") + c.string(c.escapeshellarg(pidfile))) + c.string("; exec /bin/sh"));
    borkLayoutScreen(context, ["-X", "screen", "-t", c.string(c.string(c.get(record, "run_id")) + c.string(":")) + c.string(c.get(operation, "new")), "/bin/sh", "-c", shell]);
    id = c.clone(c.get(c.explode(" ", borkLayoutScreen(context, ["-Q", "number"]), 2), 0));
    borkLayoutScreen(context, ["-X", "resize", c.equal(c.get(operation, "direction"), "right") ? "-h" : "-v", c.string(c.add(c.get(operation, "size"), 1))]);
    for (const [_key, _value] of c.entries(c.get(record, "original", "panes"))) {
      oldId = _key;
      pane = c.clone(_value);
      {
        if (!c.equal(c.string(oldId), c.get(record, "coordinator"))) {
          borkLayoutScreenFocus(context, c.string(oldId));
          borkLayoutScreen(context, ["-X", "resize", "-h", c.string(c.add(c.get(pane, "width"), 1))]);
          borkLayoutScreen(context, ["-X", "resize", "-v", c.string(c.add(c.get(pane, "height"), 1))]);
        }
      }
    }
    return id;
  } finally {
    borkLayoutScreenFocus(context, c.get(record, "original", "focus"));
  }
}
/** Reapply planned leaf dimensions after Screen equalizes split siblings. */
function borkLayoutScreenSize(record) {
  c.assertType(record, "array", "borkLayoutScreenSize.record");
  let context, resource, role, slot;
  record = c.clone(record);
  context = c.clone(c.get(record, "context"));
  try {
    for (const [_key, _value] of c.entries(c.get(record, "resources"))) {
      role = _key;
      resource = c.clone(_value);
      {
        borkLayoutScreenFocus(context, c.get(resource, "id"));
        slot = c.clone(c.get(record, "plan", "slots", role));
        if (c.equal(role, "coordinator") || c.str_starts_with(role, "review:")) {
          borkLayoutScreen(context, ["-X", "resize", "-h", c.string(c.add(c.get(slot, "width"), 1))]);
        }
        if (c.str_starts_with(role, "master:") || c.str_starts_with(role, "review:")) {
          borkLayoutScreen(context, ["-X", "resize", "-v", c.string(c.add(c.get(slot, "height"), 1))]);
        }
      }
    }
  } finally {
    borkLayoutScreenFocus(context, c.get(record, "original", "focus"));
  }
}
/** Verify that the owned Screen placeholder is still its original idle shell. */
function borkLayoutScreenIdle(record, resource) {
  c.assertType(record, "array", "borkLayoutScreenIdle.record");
  c.assertType(resource, "array", "borkLayoutScreenIdle.resource");
  let key, pid, pidfile, role, title;
  record = c.clone(record);
  resource = c.clone(resource);
  key = c.clone(c.array_search(c.get(resource, "id"), c.array_column(c.get(record, "resources"), "id"), true));
  role = c.clone(c.get(c.array_keys(c.get(record, "resources")), key));
  pidfile = c.clone(c.string(c.string(c.string(c.get(record, "record")) + c.string(".")) + c.string(c.str_replace(":", "-", role))) + c.string(".pid"));
  pid = c.clone(c.integer(c.file_get_contents(pidfile)));
  if (pid < 1 || !c.equal(c.trim(require("../terminal.js").execute(["ps", "-p", c.string(pid), "-o", "comm="])), "sh")) {
    throw new Error("Screen placeholder is no longer its original shell.");
  }
  title = c.clone(borkLayoutScreen(c.get(record, "context"), ["-p", c.get(resource, "id"), "-Q", "title"]));
  if (!c.equal(title, c.string(c.string(c.get(record, "run_id")) + c.string(":")) + c.string(role))) {
    throw new Error("Screen window ownership title changed; preserve its occupant.");
  }
  return pid;
}
/** Restore the saved full layout before removing only this run's shell windows. */
function borkLayoutScreenCleanup(record, path) {
  c.assertType(record, "array", "borkLayoutScreenCleanup.record");
  c.assertType(path, "string", "borkLayoutScreenCleanup.path");
  let context, match, resource, restored, role, snapshot;
  record = c.clone(record);
  path = c.clone(path);
  context = c.clone(c.get(record, "context"));
  c.set(record, ["pending"], "=", c.entriesArray([["restore_layout", c.get(record, "screen", "backup")]]));
  require("../layout.js").borkLayoutWrite(path, record);
  borkLayoutScreen(context, ["-X", "layout", "select", c.get(record, "screen", "backup")]);
  for (const [_key, _value] of c.entries(c.get(record, "resources"))) {
    role = _key;
    resource = c.clone(_value);
    {
      if (!c.equal(role, "coordinator")) {
        borkLayoutScreen(context, ["-p", c.get(resource, "id"), "-X", "kill"]);
        c.set(record, ["resources", role], "DELETE", null);
      }
    }
  }
  snapshot = c.clone(borkLayoutScreenSnapshot(context, c.get(record, "coordinator")));
  if (!c.equal(c.get(snapshot, "panes"), c.get(record, "original", "panes")) || !c.equal(c.get(snapshot, "focus"), c.get(record, "original", "focus"))) {
    throw new Error("Screen saved layout restoration differs from original.");
  }
  /* Selecting the original layout before removing backups preserves its active pointer. */
  if (c.truth(c.preg_match("/^This is layout ([0-9]+) \\(/", c.get(record, "screen", "original_layout"), _m => {
    match = _m;
  }))) {
    borkLayoutScreen(context, ["-X", "layout", "select", c.get(match, 1)]);
    restored = c.clone(borkLayoutScreenSnapshot(context, c.get(record, "coordinator")));
    if (!c.equal(c.get(restored, "panes"), c.get(record, "original", "panes")) || !c.equal(c.get(restored, "focus"), c.get(record, "original", "focus"))) {
      borkLayoutScreen(context, ["-X", "layout", "select", c.get(record, "screen", "backup")]);
      throw new Error("Original saved layout differs from initial live arrangement; backup restored and retained for explicit reconciliation.");
    }
    borkLayoutScreen(context, ["-X", "layout", "remove", c.get(record, "screen", "working")]);
    borkLayoutScreen(context, ["-X", "layout", "remove", c.get(record, "screen", "backup")]);
  } else {
    borkLayoutScreen(context, ["-X", "layout", "remove", c.get(record, "screen", "working")]);
    borkLayoutScreen(context, ["-X", "layout", "remove", c.get(record, "screen", "backup")]);
  }
  c.set(record, ["pending"], "=", null);
  c.set(record, ["state"], "=", "cleaned");
  require("../layout.js").borkLayoutWrite(path, record);
  return c.entriesArray([["state", "cleaned"], ["coordinator", c.get(record, "coordinator")]]);
}
/** Confirm one asynchronous Screen control without resubmitting it. */
function borkLayoutScreenMessage(context, predicate) {
  c.assertType(context, "array", "borkLayoutScreenMessage.context");
  c.assertType(predicate, "callable", "borkLayoutScreenMessage.predicate");
  predicate = c.callable(predicate);
  predicate = c.callable(predicate);
  let deadline, message;
  context = c.clone(context);
  predicate = c.clone(predicate);
  deadline = c.clone(c.add(c.microtime(true), 3));
  do {
    message = c.clone(borkLayoutScreen(context, ["-Q", "lastmsg"], false));
    if (c.truth(predicate(message))) {
      return message;
    }
    c.usleep(10000);
  } while (c.microtime(true) < deadline);
  throw new Error("Screen did not confirm control completion; preserve pending intent.");
}
module.exports = {
  borkLayoutScreen,
  borkLayoutScreenContext,
  borkLayoutScreenCapabilities,
  borkLayoutScreenTopology,
  borkLayoutScreenRect,
  borkLayoutScreenSnapshot,
  borkLayoutScreenFocus,
  borkLayoutScreenPrepare,
  borkLayoutScreenSplit,
  borkLayoutScreenSize,
  borkLayoutScreenIdle,
  borkLayoutScreenCleanup,
  borkLayoutScreenMessage
};
