'use strict';

const c = require("../../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };

/** Use the inherited Herdr session without selecting a focused or remote session. */
function borkLayoutHerdr(context, args) {
  c.assertType(context, "array", "borkLayoutHerdr.context");
  c.assertType(args, "array", "borkLayoutHerdr.args");
  let reply;
  context = c.clone(context);
  args = c.clone(args);
  if (!c.equal(c.getenv("HERDR_ENV"), "1")) {
    throw new Error("Herdr layout requires verified inherited HERDR_ENV=1 membership.");
  }
  reply = c.clone(c.json_decode(require("../terminal.js").execute(c.array_merge(context.session ? ["herdr", "--session", require("../terminal.js").field(context, "session")] : ["herdr"], args)), true, 512, c.JSON_THROW_ON_ERROR));
  if (c.get(reply, "error") != null || !c.is_array(c.get(reply, "result") ?? null)) {
    throw new Error("Herdr response lacks verified result identity.");
  }
  return c.get(reply, "result");
}
/** Normalize the documented Herdr pane-layout response. */
function borkLayoutHerdrSnapshot(context, coordinator) {
  c.assertType(context, "array", "borkLayoutHerdrSnapshot.context");
  c.assertType(coordinator, "string", "borkLayoutHerdrSnapshot.coordinator");
  let id, layout, pane, panes, reply;
  context = c.clone(context);
  coordinator = c.clone(coordinator);
  reply = c.clone(borkLayoutHerdr(context, ["pane", "layout", "--pane", coordinator]));
  layout = c.clone(c.get(reply, "layout") ?? reply);
  if (!c.equal(c.get(layout, "zoomed") ?? true, false) || !c.is_array(c.get(layout, "panes") ?? null)) {
    throw new Error("Unusable or zoomed Herdr layout snapshot.");
  }
  panes = c.clone([]);
  for (const [_key, _value] of c.entries(c.get(layout, "panes"))) {
    pane = c.clone(_value);
    {
      id = c.clone(require("../terminal.js").field(pane, "pane_id"));
      c.set(panes, [id], "=", c.array_merge(c.get(pane, "rect"), c.entriesArray([["id", id], ["window", require("../terminal.js").field(layout, "tab_id")], ["session", require("../terminal.js").field(layout, "workspace_id")]])));
    }
  }
  if (!(c.get(panes, coordinator) != null)) {
    throw new Error("Herdr coordinator is absent from its recorded tab.");
  }
  return c.entriesArray([["panes", panes], ["focus", require("../terminal.js").field(layout, "focused_pane_id")]]);
}
/** Check exact ratio and background split controls before mutation. */
function borkLayoutHerdrCapabilities(context) {
  c.assertType(context, "array", "borkLayoutHerdrCapabilities.context");
  let flag, help;
  context = c.clone(context);
  help = c.clone(require("../terminal.js").execute(["herdr", "pane", "split", "--help"]));
  for (const [_key, _value] of c.entries(["--ratio", "--no-focus", "--pane", "--cwd"])) {
    flag = c.clone(_value);
    {
      if (!c.str_contains(help, flag)) {
        throw new Error(c.string("Missing Herdr layout capability: ") + c.string(flag));
      }
    }
  }
  return c.entriesArray([["version", require("../terminal.js").execute(["herdr", "--version"])], ["split_help_sha256", c.hash("sha256", help)]]);
}
/** Split the exact owned subtree without changing Herdr focus. */
function borkLayoutHerdrSplit(record, operation) {
  c.assertType(record, "array", "borkLayoutHerdrSplit.record");
  c.assertType(operation, "array", "borkLayoutHerdrSplit.operation");
  let axis, parent, ratio, reply, snapshot, total;
  record = c.clone(record);
  operation = c.clone(operation);
  parent = c.clone(c.get(record, "resources", c.get(operation, "parent"), "id"));
  snapshot = c.clone(borkLayoutHerdrSnapshot(c.get(record, "context"), c.get(record, "coordinator")));
  axis = c.clone(c.equal(c.get(operation, "direction"), "right") ? "width" : "height");
  total = c.clone(c.get(snapshot, "panes", parent, axis));
  /* Request the retained child's share; verify actual rectangles after creation. */
  ratio = c.clone((total - c.get(operation, "size")) / total);
  reply = c.clone(borkLayoutHerdr(c.get(record, "context"), ["pane", "split", "--pane", parent, "--direction", c.get(operation, "direction"), "--ratio", c.string(ratio), "--cwd", c.get(record, "cwd"), "--no-focus"]));
  return require("../terminal.js").field(c.get(reply, "pane") ?? [], "pane_id");
}
module.exports = {
  borkLayoutHerdr,
  borkLayoutHerdrSnapshot,
  borkLayoutHerdrCapabilities,
  borkLayoutHerdrSplit
};
