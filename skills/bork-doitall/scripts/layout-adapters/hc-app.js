'use strict';

const c = require("../../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };

/** Keep app and core calls on the explicitly recorded local endpoints. */
function borkLayoutAppEnvironment(context) {
  c.assertType(context, "array", "borkLayoutAppEnvironment.context");
  let environment, key, name;
  context = c.clone(context);
  environment = c.clone(c.getenv());
  for (const [_key, _value] of c.entries(c.entriesArray([["session", "HC_SESSION"], ["app_home", "HERDR_APP_HOME"]]))) {
    key = _key;
    name = c.clone(_value);
    {
      if (c.get(context, key) != null) {
        c.set(environment, [name], "=", require("../terminal.js").field(context, key));
      }
    }
  }
  return environment;
}
/** Read or call the documented newline JSON-RPC core interface. */
function borkLayoutAppRpc(context, method, params = {}) {
  c.assertType(context, "array", "borkLayoutAppRpc.context");
  c.assertType(method, "string", "borkLayoutAppRpc.method");
  c.assertType(params, "array", "borkLayoutAppRpc.params");
  const args = ['hc', 'connect'];
  if (context.session !== undefined) args.push('--session', require('../terminal.js').field(context, 'session'));
  const result = c.processResult(args, {
    env: c.object(borkLayoutAppEnvironment(context)),
    input: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: c.object(params)
    }) + '\n'
  });
  if (result.error) throw new Error('Cannot reach recorded app core.');
  const reply = JSON.parse(result.output.trim());
  if (result.code !== 0 || reply.error !== undefined || !c.is_array(reply.result)) throw new Error('Core request failed; preserve layout intent and reconcile.');
  return reply.result;
}

/** Invoke only public app controls, without starting or raising a window. */
function borkLayoutAppCommand(context, name, args = null) {
  c.assertType(context, "array", "borkLayoutAppCommand.context");
  c.assertType(name, "string", "borkLayoutAppCommand.name");
  c.assertType(args, "?array", "borkLayoutAppCommand.args");
  let argv, reply;
  context = c.clone(context);
  name = c.clone(name);
  args = c.clone(args);
  argv = c.clone(c.equal(args, null) ? ["herdr-app", name] : ["herdr-app", "do", name, c.json_encode(args, c.JSON_THROW_ON_ERROR)]);
  reply = c.clone(c.json_decode(require("../terminal.js").execute(argv, [0], borkLayoutAppEnvironment(context)), true, 512, c.JSON_THROW_ON_ERROR));
  if (!c.is_array(reply) || c.get(reply, "error") != null) {
    throw new Error("App control failed; reconcile the saved mutation.");
  }
  return reply;
}
/** Find a public split-tree node and its immediate siblings. */
function borkLayoutAppFind(node, id, parent = null) {
  c.assertType(node, "array", "borkLayoutAppFind.node");
  c.assertType(id, "string", "borkLayoutAppFind.id");
  c.assertType(parent, "?array", "borkLayoutAppFind.parent");
  let child, found;
  node = c.clone(node);
  id = c.clone(id);
  parent = c.clone(parent);
  if (c.equal(c.get(node, "id") ?? null, id)) {
    return c.entriesArray([["node", node], ["parent", parent]]);
  }
  for (const [_key, _value] of c.entries(c.get(node, "children") ?? [])) {
    child = c.clone(_value);
    {
      found = c.clone(borkLayoutAppFind(child, id, node));
      if (!c.equal(found, null)) {
        return found;
      }
    }
  }
  return null;
}
/** Resolve the exact active local tab from the complete public document. */
function borkLayoutAppTree(context, coordinator) {
  c.assertType(context, "array", "borkLayoutAppTree.context");
  c.assertType(coordinator, "string", "borkLayoutAppTree.coordinator");
  let document, server, space, status, tab;
  context = c.clone(context);
  coordinator = c.clone(coordinator);
  server = c.clone(borkLayoutAppRpc(context, "server.status"));
  if (c.get(context, "core_id") != null && !c.equal(c.get(server, "core", "id") ?? null, c.get(context, "core_id"))) {
    throw new Error("Recorded app core identity changed.");
  }
  status = c.clone(borkLayoutAppCommand(context, "status"));
  if (!c.equal(c.get(status, "overlays") ?? [], []) || !c.equal(c.get(status, "errors") ?? [], [])) {
    throw new Error("Resolve app overlays or errors before background layout changes.");
  }
  document = c.clone(borkLayoutAppRpc(context, "doc.get", c.entriesArray([["name", "herdr-app"]])));
  for (const [_key, _value] of c.entries(c.get(document, "value", "spaces") ?? [])) {
    space = c.clone(_value);
    {
      for (const [_key, _value] of c.entries(c.get(space, "tabs") ?? [])) {
        tab = c.clone(_value);
        {
          if (!c.equal(borkLayoutAppFind(c.get(tab, "root"), coordinator), null)) {
            if (!c.equal(c.get(space, "id"), c.get(status, "space") ?? null) || !c.equal(c.get(tab, "id"), c.get(status, "tab") ?? null)) {
              throw new Error("Coordinator is outside the active app space/tab.");
            }
            return c.entriesArray([["root", c.get(tab, "root")], ["tab", c.get(tab, "id")], ["space", c.get(space, "id")], ["status", status], ["version", c.get(document, "version")], ["core_id", c.get(server, "core", "id")]]);
          }
        }
      }
    }
  }
  throw new Error("Coordinator is absent from the recorded app document.");
}
/** Map weighted tree topology to logical cells, retaining actual terminal geometry. */
function borkLayoutAppWalk(context, node, area, tree, panes) {
  c.assertType(context, "array", "borkLayoutAppWalk.context");
  c.assertType(node, "array", "borkLayoutAppWalk.node");
  c.assertType(area, "array", "borkLayoutAppWalk.area");
  c.assertType(tree, "array", "borkLayoutAppWalk.tree");
  c.assertType(panes, "array", "borkLayoutAppWalk.panes");
  let actual, axis, child, children, cumulative, end, index, offset, position, rect, shown, terminal, usable, weight;
  context = c.clone(context);
  node = c.clone(node);
  area = c.clone(area);
  tree = c.clone(tree);
  if (c.truth(c.get(node, "hidden") ?? false) || !c.in_array(c.get(node, "type") ?? "", ["row", "column", "block"], true)) {
    throw new Error("Hidden/stack app nodes require an explicit supported geometry mapping.");
  }
  if (c.equal(c.get(node, "type"), "block")) {
    terminal = c.clone(require("../terminal.js").field(c.get(node, "content") ?? [], "terminal"));
    shown = c.clone(c.get(context, "visible", c.get(node, "id")) ?? terminal);
    actual = c.clone(borkLayoutAppRpc(context, "terminal.get", c.entriesArray([["terminal", shown]])));
    c.set(panes, [c.get(node, "id")], "=", c.add(area, c.entriesArray([["id", c.get(node, "id")], ["window", c.get(tree, "tab")], ["session", c.get(tree, "space")], ["terminal", terminal], ["cols", c.get(actual, "cols") ?? 0], ["rows", c.get(actual, "rows") ?? 0], ["created_ms", c.get(actual, "created_ms") ?? null], ["node", node]])));
    return;
  }
  children = c.clone(c.get(node, "children") ?? []);
  if (!c.truth(children)) {
    throw new Error("App container has no measured leaves.");
  }
  axis = c.clone(c.equal(c.get(node, "type"), "row") ? "width" : "height");
  position = c.clone(c.equal(c.get(node, "type"), "row") ? "x" : "y");
  weight = 0.0;
  for (const [_key, _value] of c.entries(children)) {
    child = c.clone(_value);
    {
      if (c.get(child, "size", "px") != null || (c.get(child, "size", "weight") ?? 1) <= 0) {
        throw new Error("Pixel-sized or nonpositive app splits require geometry reconciliation before layout.");
      }
      weight = c.add(weight, c.get(child, "size", "weight") ?? 1);
    }
  }
  usable = c.clone(c.add(c.get(area, axis) - c.count(children), 1));
  offset = 0;
  cumulative = 0.0;
  for (const [_key, _value] of c.entries(children)) {
    index = _key;
    child = c.clone(_value);
    {
      cumulative = c.add(cumulative, c.get(child, "size", "weight") ?? 1);
      end = c.clone(c.equal(index, c.count(children) - 1) ? usable : c.integer(c.round(usable * cumulative / weight)));
      rect = c.clone(c.array_replace(area, c.entriesArray([[position, c.add(c.add(c.get(area, position), offset), index)], [axis, end - offset]])));
      borkLayoutAppWalk(context, child, rect, tree, panes);
      offset = c.clone(end);
    }
  }
}
/** Snapshot public topology, stable bindings, live terminal cells and final focus. */
function borkLayoutAppSnapshot(context, coordinator) {
  c.assertType(context, "array", "borkLayoutAppSnapshot.context");
  c.assertType(coordinator, "string", "borkLayoutAppSnapshot.coordinator");
  let actual, area, leaf, panes, tree, unit;
  context = c.clone(context);
  coordinator = c.clone(coordinator);
  tree = c.clone(borkLayoutAppTree(context, coordinator));
  area = c.clone(c.get(context, "root_area") ?? null);
  if (c.equal(area, null)) {
    leaf = c.clone(c.get(borkLayoutAppFind(c.get(tree, "root"), coordinator), "node"));
    actual = c.clone(borkLayoutAppRpc(context, "terminal.get", c.entriesArray([["terminal", require("../terminal.js").field(c.get(leaf, "content") ?? [], "terminal")]])));
    area = c.clone(c.entriesArray([["x", 0], ["y", 0], ["width", c.get(actual, "cols")], ["height", c.get(actual, "rows")]]));
    /* Recover root cell scale from a virtual unit tree and the measured coordinator. */
    unit = c.clone([]);
    borkLayoutAppWalk(context, c.get(tree, "root"), c.entriesArray([["x", 0], ["y", 0], ["width", 100000], ["height", 100000]]), tree, unit);
    c.set(area, ["width"], "=", c.integer(c.round(c.get(area, "width") * 100000 / c.get(unit, coordinator, "width"))));
    c.set(area, ["height"], "=", c.integer(c.round(c.get(area, "height") * 100000 / c.get(unit, coordinator, "height"))));
  }
  panes = c.clone([]);
  borkLayoutAppWalk(context, c.get(tree, "root"), area, tree, panes);
  return c.entriesArray([["panes", panes], ["focus", require("../terminal.js").field(c.get(tree, "status"), "focused_pane")], ["tree", tree], ["root_area", area]]);
}
/** Resolve equivalent documented read, split, size and focus controls before mutation. */
function borkLayoutAppCapabilities(context = []) {
  c.assertType(context, "array", "borkLayoutAppCapabilities.context");
  let commands, name, names;
  context = c.clone(context);
  commands = c.clone(borkLayoutAppCommand(context, "commands"));
  names = c.clone(c.array_column(commands, "name"));
  for (const [_key, _value] of c.entries(["pane.split", "pane.close", "pane.focus", "layout.resize", "terminal.show"])) {
    name = c.clone(_value);
    {
      if (!c.in_array(name, names, true)) {
        throw new Error(c.string("Missing app layout command: ") + c.string(name));
      }
    }
  }
  return c.entriesArray([["supported", true], ["commands_sha256", c.hash("sha256", c.json_encode(commands, c.JSON_THROW_ON_ERROR))], ["focus", "Splits focus transiently; operation-entry focus is restored unless navigation has superseded it."]]);
}
/** Restore operation-entry focus only while the operation still owns current focus. */
function borkLayoutAppRestoreFocus(record, focus, expected) {
  const context = record.context;
  const current = borkLayoutAppCommand(context, 'status').focused_pane;
  if (current === focus || current !== expected) return;
  borkLayoutAppCommand(context, 'pane.focus', {pane: focus});
}
/** Split an owned subtree and proportionally preserve its original sibling share. */
function borkLayoutAppSplit(record, operation) {
  c.assertType(record, "array", "borkLayoutAppSplit.record");
  c.assertType(operation, "array", "borkLayoutAppSplit.operation");
  let axis, context, found, id, orientation, parent, ratio, reply, share, snapshot;
  record = c.clone(record);
  operation = c.clone(operation);
  context = c.clone(c.get(record, "context"));
  parent = c.clone(c.get(record, "resources", c.get(operation, "parent"), "id"));
  snapshot = c.clone(borkLayoutAppSnapshot(context, c.get(record, "coordinator")));
  found = c.clone(borkLayoutAppFind(c.get(snapshot, "tree", "root"), parent));
  axis = c.clone(c.equal(c.get(operation, "direction"), "right") ? "width" : "height");
  orientation = c.clone(c.equal(c.get(operation, "direction"), "right") ? "row" : "column");
  share = c.clone(c.equal(c.get(found, "parent", "type") ?? null, orientation) ? c.get(found, "node", "size", "weight") ?? 1 : 1);
  ratio = c.clone(c.get(operation, "size") / (c.get(snapshot, "panes", parent, axis) - 1));
  try {
    reply = c.clone(borkLayoutAppCommand(context, "pane.split", c.entriesArray([["pane", parent], ["direction", c.get(operation, "direction")], ["argv", ["/bin/sh"]]])));
    id = c.clone(require("../terminal.js").field(reply, "pane"));
    borkLayoutAppCommand(context, "layout.resize", c.entriesArray([["id", parent], ["weight", share * (1 - ratio)]]));
    borkLayoutAppCommand(context, "layout.resize", c.entriesArray([["id", id], ["weight", share * ratio]]));
    borkLayoutAppAwait(context, c.get(record, "coordinator"), function (tree) {
      let newValue, old;
      tree = c.clone(tree);
      old = c.clone(borkLayoutAppFind(c.get(tree, "root"), parent));
      newValue = c.clone(borkLayoutAppFind(c.get(tree, "root"), id));
      return !c.equal(old, null) && !c.equal(newValue, null) && c.abs((c.get(old, "node", "size", "weight") ?? 1) - share * (1 - ratio)) < 0.00001 && c.abs((c.get(newValue, "node", "size", "weight") ?? 1) - share * ratio) < 0.00001;
    });
    return id;
  } finally {
    borkLayoutAppRestoreFocus(record, c.get(snapshot, "focus"), id);
  }
}
/** Wait boundedly for asynchronous public document persistence, never replaying a mutation. */
function borkLayoutAppAwait(context, coordinator, predicate) {
  c.assertType(context, "array", "borkLayoutAppAwait.context");
  c.assertType(coordinator, "string", "borkLayoutAppAwait.coordinator");
  c.assertType(predicate, "callable", "borkLayoutAppAwait.predicate");
  predicate = c.callable(predicate);
  predicate = c.callable(predicate);
  let deadline, tree;
  context = c.clone(context);
  coordinator = c.clone(coordinator);
  predicate = c.clone(predicate);
  deadline = c.clone(c.add(c.microtime(true), 4));
  do {
    tree = c.clone(borkLayoutAppTree(context, coordinator));
    if (c.truth(predicate(tree))) {
      return tree;
    }
    c.usleep(50000);
  } while (c.microtime(true) < deadline);
  throw new Error("App document persistence did not confirm mutation; preserve pending intent.");
}
/** Observe settled rendered terminal cells independently of logical weighted rectangles. */
function borkLayoutAppStable(record, expected = false, refresh = null) {
  c.assertType(record, "array", "borkLayoutAppStable.record");
  c.assertType(expected, "bool", "borkLayoutAppStable.expected");
  c.assertType(refresh, "?callable", "borkLayoutAppStable.refresh");
  let cells, deadline, matches, previous, resource, snapshot;
  record = c.clone(record);
  expected = c.clone(expected);
  refresh = c.clone(refresh);
  previous = null;
  deadline = c.clone(c.add(c.microtime(true), 4));
  do {
    if (!c.equal(refresh, null)) {
      refresh();
    }
    snapshot = c.clone(require("../layout.js").borkLayoutSnapshot(record));
    cells = c.clone(c.array_map(function (pane) {
      pane = c.clone(pane);
      return [c.get(pane, "cols"), c.get(pane, "rows")];
    }, c.get(snapshot, "panes")));
    matches = true;
    if (c.truth(expected)) {
      for (const [_key, _value] of c.entries(c.get(record, "resources"))) {
        resource = c.clone(_value);
        {
          matches = c.clone(c.truth(matches) && c.equal(c.get(cells, c.get(resource, "id")), c.get(resource, "actual_cells") ?? c.get(cells, c.get(resource, "id"))));
        }
      }
    }
    if (c.truth(matches) && c.equal(cells, previous)) {
      return snapshot;
    }
    previous = c.clone(cells);
    c.usleep(50000);
  } while (c.microtime(true) < deadline);
  throw new Error("App rendered geometry did not settle; retain layout for reconciliation.");
}
/** Preserve fresh entry focus for each idempotent terminal-view update. */
function borkLayoutAppShow(record, args) {
  const focus = borkLayoutAppCommand(record.context, 'status').focused_pane;
  try { borkLayoutAppCommand(record.context, 'terminal.show', args); }
  finally { borkLayoutAppRestoreFocus(record, focus, args.pane); }
}
/** Bind a claimed visible placement to its exact owned hc terminal or restore its shell. */
function borkLayoutAppBind(input, record) {
  c.assertType(input, "array", "borkLayoutAppBind.input");
  c.assertType(record, "array", "borkLayoutAppBind.record");
  let args, key, resource, terminal;
  input = c.clone(input);
  record = c.clone(record);
  if (!c.equal(c.get(record, "driver"), "hc")) {
    throw new Error("Visible terminal bindings require the recorded App adapter.");
  }
  require("../layout.js").borkLayoutVerify(record, true, false);
  key = c.clone(require("../terminal.js").field(input, "placement"));
  resource = c.clone(c.get(record, "resources", key) ?? []);
  if (!c.equal(c.get(resource, "state") ?? null, "claimed") || !c.equal(c.get(resource, "task_id") ?? null, require("../terminal.js").field(input, "task_id"))) {
    throw new Error("App binding does not match the claimed task.");
  }
  args = c.clone(c.entriesArray([["pane", c.get(resource, "id")]]));
  if (c.equal(c.get(input, "show") ?? true, true)) {
    terminal = c.clone(borkLayoutAppRpc(c.get(record, "context"), "terminal.get", c.entriesArray([["terminal", require("../terminal.js").field(input, "terminal_id")]])));
    if (!c.is_int(c.get(input, "created_ms") ?? null) || !c.equal(c.get(terminal, "created_ms") ?? null, c.get(input, "created_ms")) || !c.equal(c.get(terminal, "address") ?? null, c.get(input, "terminal_id")) || !c.equal(c.get(resource, "run_id") ?? null, require("../terminal.js").field(input, "run_id")) || !c.equal(c.get(terminal, "labels", "bork-run") ?? null, c.get(resource, "run_id")) || !c.equal(c.get(terminal, "labels", "bork-task") ?? null, c.get(resource, "task_id"))) {
      throw new Error("Visible App terminal ownership changed.");
    }
    c.set(args, ["terminal"], "=", c.get(input, "terminal_id"));
  }
  borkLayoutAppShow(record, args);
  c.set(record, ["resources", key, "visible_terminal"], "DELETE", null);
  if (c.get(args, "terminal") != null) {
    c.set(record, ["resources", key, "visible_terminal"], "=", c.get(args, "terminal"));
  }
  /* Reapply only the idempotent view binding while App incorporates the new core terminal. */
  borkLayoutAppStable(record, true, function () {
    borkLayoutAppShow(record, args);
  });
  require("../layout.js").borkLayoutVerify(record);
  require("../layout.js").borkLayoutWrite(require("../terminal.js").field(input, "record"), record);
  return c.get(record, "resources", key);
}
module.exports = {
  borkLayoutAppEnvironment,
  borkLayoutAppRpc,
  borkLayoutAppCommand,
  borkLayoutAppFind,
  borkLayoutAppTree,
  borkLayoutAppWalk,
  borkLayoutAppSnapshot,
  borkLayoutAppCapabilities,
  borkLayoutAppRestoreFocus,
  borkLayoutAppSplit,
  borkLayoutAppAwait,
  borkLayoutAppStable,
  borkLayoutAppBind
};
