'use strict';

const c = require("../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };
const {
  field
} = require("./terminal.js");
const {
  borkLayoutPlan
} = require("./layout-plan.js");
let adapter, error, result;
for (const [_key, _value] of c.entries(["tmux", "herdr", "hc-app", "screen"])) {
  adapter = c.clone(_value);
  {}
}
/** Atomically persist a layout journal outside disposable worktrees. */
function borkLayoutWrite(path, record) {
  c.assertType(path, "string", "borkLayoutWrite.path");
  c.assertType(record, "array", "borkLayoutWrite.record");
  c.atomicWrite(path, c.json_encode(record, c.JSON_PRETTY_PRINT), '.layout-');
}

/** Read the selected driver's live snapshot without switching drivers. */
function borkLayoutSnapshot(record) {
  c.assertType(record, "array", "borkLayoutSnapshot.record");
  let resource;
  record = c.clone(record);
  if (c.equal(c.get(record, "driver"), "hc")) {
    for (const [_key, _value] of c.entries(c.get(record, "resources") ?? [])) {
      resource = c.clone(_value);
      {
        if (c.get(resource, "visible_terminal") != null) {
          c.set(record, ["context", "visible", c.get(resource, "id")], "=", c.get(resource, "visible_terminal"));
        }
      }
    }
  }
  return (_match => c.equal(_match, "tmux") ? require("./layout-adapters/tmux.js").borkLayoutTmuxSnapshot(c.get(record, "context"), c.get(record, "coordinator")) : c.equal(_match, "herdr") ? require("./layout-adapters/herdr.js").borkLayoutHerdrSnapshot(c.get(record, "context"), c.get(record, "coordinator")) : c.equal(_match, "hc") ? require("./layout-adapters/hc-app.js").borkLayoutAppSnapshot(c.get(record, "context"), c.get(record, "coordinator")) : c.equal(_match, "screen") ? require("./layout-adapters/screen.js").borkLayoutScreenSnapshot(c.get(record, "context"), c.get(record, "coordinator")) : c.fail(new Error("Visual adapter has no verified geometry interface.")))(c.get(record, "driver"));
}
/** Verify placement identity, surrounding panes and geometry independently of user focus. */
function borkLayoutVerify(record, geometry = true, rendered = true) {
  c.assertType(record, "array", "borkLayoutVerify.record");
  c.assertType(geometry, "bool", "borkLayoutVerify.geometry");
  c.assertType(rendered, "bool", "borkLayoutVerify.rendered");
  let id, ids, pane, placement, resource, snapshot;
  record = c.clone(record);
  geometry = c.clone(geometry);
  rendered = c.clone(rendered);
  if (!c.equal(c.get(record, "pending") ?? null, null)) {
    throw new Error("Uncertain layout mutation requires reconciliation; do not repeat it.");
  }
  snapshot = c.clone(borkLayoutSnapshot(record));
  for (const [_key, _value] of c.entries(c.get(record, "resources"))) {
    placement = _key;
    resource = c.clone(_value);
    {
      pane = c.clone(c.get(snapshot, "panes", c.get(resource, "id")) ?? null);
      if (c.equal(pane, null) || !c.equal(c.get(pane, "window"), c.get(record, "original", "panes", c.get(record, "coordinator"), "window"))) {
        throw new Error("Owned placement is missing or changed window.");
      }
      if (c.equal(c.get(record, "driver"), "tmux") && !c.equal(placement, "coordinator") && (!c.equal(c.get(pane, "owner"), c.get(record, "run_id")) || !c.equal(c.get(pane, "placement"), placement))) {
        throw new Error("Pane ownership no longer matches this layout.");
      }
      if (c.equal(c.get(record, "driver"), "hc") && !c.equal(placement, "coordinator") && c.truth(geometry) && c.truth(rendered) && (c.get(pane, "cols") < 35 || c.get(pane, "rows") < 6)) {
        throw new Error("Rendered App terminal is below usable worker bounds; preserve layout for recovery.");
      }
      if (c.equal(c.get(record, "driver"), "hc") && c.get(resource, "actual_cells") != null && c.truth(geometry) && c.truth(rendered) && !c.equal(c.get(resource, "actual_cells"), [c.get(pane, "cols"), c.get(pane, "rows")])) {
        throw new Error(c.string(c.string(c.string(c.string(c.string(c.string("Rendered App geometry changed for ") + c.string(placement)) + c.string(": expected ")) + c.string(c.json_encode(c.get(resource, "actual_cells")))) + c.string(", observed ")) + c.string(c.json_encode([c.get(pane, "cols"), c.get(pane, "rows")]))) + c.string("; reconcile resize before new claims."));
      }
      if (c.truth(geometry)) {
        require("./layout-plan.js").borkLayoutGeometry(c.get(record, "plan", "slots", placement), pane, c.equal(c.get(record, "driver"), "herdr") ? 1 : 0);
      }
    }
  }
  for (const [_key, _value] of c.entries(c.get(record, "original", "panes"))) {
    id = _key;
    pane = c.clone(_value);
    {
      if (!c.equal(c.string(id), c.get(record, "coordinator"))) {
        require("./layout-plan.js").borkLayoutGeometry(pane, c.get(snapshot, "panes", id) ?? []);
      }
    }
  }
  ids = c.clone(c.array_column(c.get(record, "resources"), "id"));
  for (const [_key, _value] of c.entries(c.get(snapshot, "panes"))) {
    id = _key;
    pane = c.clone(_value);
    {
      if (!(c.get(record, "original", "panes", id) != null) && !c.in_array(c.string(id), ids, true)) {
        throw new Error("An unrelated pane appeared; reconcile before modifying the layout.");
      }
    }
  }
  return snapshot;
}
/** Preflight a visual host and plan from its actual coordinator rectangle. */
function borkLayoutPreflight(input) {
  c.assertType(input, "array", "borkLayoutPreflight.input");
  let capability, context, driver, record, snapshot;
  input = c.clone(input);
  driver = c.clone(require("./terminal.js").field(input, "driver"));
  if (c.equal(driver, "hc") && c.equal(c.get(input, "visual_host") ?? null, null)) {
    return c.entriesArray([["supported", true], ["visual", false], ["reason", "Headless hc manages terminals. Visual arrangement requires a supported Herdr App interface."]]);
  }
  context = c.clone(c.get(input, "context") ?? []);
  capability = c.clone((_match => c.equal(_match, "tmux") ? require("./layout-adapters/tmux.js").borkLayoutTmuxCapabilities(context) : c.equal(_match, "herdr") ? require("./layout-adapters/herdr.js").borkLayoutHerdrCapabilities(context) : c.equal(_match, "hc") ? require("./layout-adapters/hc-app.js").borkLayoutAppCapabilities(context) : c.equal(_match, "screen") ? require("./layout-adapters/screen.js").borkLayoutScreenCapabilities(context) : c.fail(new Error("Unsupported layout driver.")))(driver));
  if (c.equal(c.get(capability, "supported") ?? true, false)) {
    return c.entriesArray([["supported", false], ["visual", true], ["capability", capability]]);
  }
  if (c.equal(driver, "screen")) {
    context = c.clone(require("./layout-adapters/screen.js").borkLayoutScreenContext(context, require("./terminal.js").field(input, "coordinator")));
  }
  record = c.clone(c.entriesArray([["driver", driver], ["context", context], ["coordinator", require("./terminal.js").field(input, "coordinator")]]));
  snapshot = c.clone(borkLayoutSnapshot(record));
  return c.entriesArray([["supported", true], ["visual", true], ["capability", capability], ["snapshot", snapshot], ["context", context], ["plan", require("./layout-plan.js").borkLayoutPlan(c.get(input, "concurrency") ?? 1, c.array_intersect_key(c.get(snapshot, "panes", c.get(record, "coordinator")), c.array_flip(["x", "y", "width", "height"])), c.equal(driver, "herdr") ? 0 : 1)]]);
}
/** Provision placeholders once, journaling every split before mutation. */
function borkLayoutCreate(input) {
  c.assertType(input, "array", "borkLayoutCreate.input");
  let created, id, index, operation, pane, path, preflight, record, resource, run, snapshot;
  input = c.clone(input);
  path = c.clone(require("./terminal.js").field(input, "record"));
  if (c.file_exists(path) || c.is_link(path)) {
    throw new Error("Layout record exists; inspect it instead of creating another layout.");
  }
  preflight = c.clone(borkLayoutPreflight(input));
  if (!c.truth(c.get(preflight, "supported"))) {
    throw new Error(c.get(preflight, "capability", "reason"));
  }
  if (!c.truth(c.get(preflight, "visual"))) {
    return preflight;
  }
  run = c.clone(require("./terminal.js").field(input, "run_id"));
  if (!c.truth(c.preg_match("/^[a-zA-Z0-9_-]+$/D", run)) || !c.is_dir(require("./terminal.js").field(input, "cwd"))) {
    throw new Error("Invalid run identity or working directory.");
  }
  record = c.clone(c.array_merge(input, c.entriesArray([["version", 1], ["state", "creating"], ["context", c.get(preflight, "context")], ["plan", c.get(preflight, "plan")], ["capability", c.get(preflight, "capability")], ["original", c.get(preflight, "snapshot")], ["resources", c.entriesArray([["coordinator", c.entriesArray([["id", c.get(input, "coordinator")], ["state", "protected"]])]])], ["pending", null]])));
  if (c.equal(c.get(record, "driver"), "hc")) {
    c.set(record, ["context", "root_area"], "=", c.get(record, "original", "root_area"));
    c.set(record, ["context", "core_id"], "=", c.get(record, "original", "tree", "core_id"));
  }
  borkLayoutWrite(path, record);
  if (c.equal(c.get(record, "driver"), "screen")) {
    record = c.clone(require("./layout-adapters/screen.js").borkLayoutScreenPrepare(record));
    borkLayoutWrite(path, record);
  }
  for (const [_key, _value] of c.entries(c.get(record, "plan", "operations"))) {
    index = _key;
    operation = c.clone(_value);
    {
      c.set(record, ["pending"], "=", c.entriesArray([["operation", operation], ["index", index], ["before", borkLayoutSnapshot(record)]]));
      borkLayoutWrite(path, record);
      id = c.clone((_match => c.equal(_match, "tmux") ? require("./layout-adapters/tmux.js").borkLayoutTmuxSplit(record, operation) : c.equal(_match, "herdr") ? require("./layout-adapters/herdr.js").borkLayoutHerdrSplit(record, operation) : c.equal(_match, "hc") ? require("./layout-adapters/hc-app.js").borkLayoutAppSplit(record, operation) : c.equal(_match, "screen") ? require("./layout-adapters/screen.js").borkLayoutScreenSplit(record, operation) : c.fail(new Error("Unhandled match")))(c.get(record, "driver")));
      created = c.clone(c.get(c.get(borkLayoutSnapshot(record), "panes"), id) ?? null);
      if (c.equal(created, null)) {
        throw new Error("Returned split pane cannot be verified; preserve pending intent.");
      }
      c.set(record, ["resources", c.get(operation, "new")], "=", c.entriesArray([["id", id], ["state", "placeholder"], ["idle_pid", c.get(created, "pid") ?? null], ["idle_command", c.get(created, "command") ?? null], ["terminal", c.get(created, "terminal") ?? null], ["created_ms", c.get(created, "created_ms") ?? null]]));
      c.set(record, ["pending"], "=", null);
      borkLayoutWrite(path, record);
      borkLayoutVerify(record, false);
    }
  }
  if (c.equal(c.get(record, "driver"), "screen")) {
    require("./layout-adapters/screen.js").borkLayoutScreenSize(record);
  }
  if (c.equal(c.get(record, "driver"), "hc")) {
    snapshot = c.clone(require("./layout-adapters/hc-app.js").borkLayoutAppStable(record));
    for (const [_key, _value] of c.entries(c.get(record, "resources"))) {
      resource = _value;
      {
        pane = c.clone(c.get(snapshot, "panes", c.get(resource, "id")));
        c.set(resource, ["actual_cells"], "=", [c.get(pane, "cols"), c.get(pane, "rows")]);
      }
    }
  }
  borkLayoutVerify(record);
  c.set(record, ["state"], "=", "ready");
  borkLayoutWrite(path, record);
  return record;
}
/** Refuse to replace or close a placeholder occupied by an unowned process. */
function borkLayoutIdle(record, key) {
  c.assertType(record, "array", "borkLayoutIdle.record");
  c.assertType(key, "string", "borkLayoutIdle.key");
  let command, fields, foreground, info, line, pane, pid, resource, snapshot, terminal;
  record = c.clone(record);
  key = c.clone(key);
  resource = c.clone(c.get(record, "resources", key));
  snapshot = c.clone(borkLayoutSnapshot(record));
  pane = c.clone(c.get(snapshot, "panes", c.get(resource, "id")));
  if (c.equal(c.get(record, "driver"), "tmux")) {
    if (c.truth(c.get(pane, "dead"))) {
      return;
    }
    if (!c.equal(c.get(pane, "pid"), c.get(resource, "idle_pid"))) {
      throw new Error("Placeholder process identity changed; preserve its occupant.");
    }
    pid = c.clone(c.get(pane, "pid"));
    command = c.clone(c.ltrim(c.trim(require("./terminal.js").execute(["ps", "-p", c.string(pid), "-o", "comm="])), "-"));
    if (!c.in_array(command, ["sh", "dash"], true)) {
      throw new Error("Placeholder is not its original idle shell.");
    }
  } else if (c.equal(c.get(record, "driver"), "hc")) {
    terminal = c.clone(require("./layout-adapters/hc-app.js").borkLayoutAppRpc(c.get(record, "context"), "terminal.get", c.entriesArray([["terminal", c.get(resource, "terminal")]])));
    if (!c.equal(c.get(terminal, "created_ms") ?? null, c.get(resource, "created_ms")) || !c.equal(c.get(terminal, "state") ?? null, "live") || !c.equal(c.get(terminal, "argv") ?? null, ["/bin/sh"])) {
      throw new Error("App placeholder terminal identity or shell changed.");
    }
    pid = c.clone(c.get(terminal, "pid"));
    if (!c.in_array(c.trim(require("./terminal.js").execute(["ps", "-p", c.string(pid), "-o", "comm="])), ["sh", "dash"], true)) {
      throw new Error("App placeholder is occupied by another foreground process.");
    }
  } else if (c.equal(c.get(record, "driver"), "screen")) {
    pid = c.clone(require("./layout-adapters/screen.js").borkLayoutScreenIdle(record, resource));
  } else {
    info = c.clone(require("./layout-adapters/herdr.js").borkLayoutHerdr(c.get(record, "context"), ["pane", "process-info", "--pane", c.get(resource, "id")]));
    info = c.clone(c.get(info, "process_info") ?? info);
    foreground = c.clone(c.get(info, "foreground_processes") ?? []);
    if (!c.is_int(c.get(info, "shell_pid") ?? null) || !c.equal(c.count(foreground), 1) || !c.equal(c.get(foreground, 0, "pid") ?? null, c.get(info, "shell_pid"))) {
      throw new Error("Placeholder is not an available foreground shell.");
    }
    pid = c.clone(c.get(info, "shell_pid"));
  }
  for (const [_key, _value] of c.entries(c.explode("\n", require("./terminal.js").execute(["ps", "-eo", "pid=,ppid="])))) {
    line = c.clone(_value);
    {
      fields = c.clone(c.preg_split("/\\s+/", c.trim(line)));
      if (c.equal(c.count(fields), 2) && c.equal(c.integer(c.get(fields, 1)), pid)) {
        throw new Error("Placeholder has active child processes; preserve them.");
      }
    }
  }
}
/** Reserve a stable role placement without starting or duplicating a worker. */
function borkLayoutClaim(input, record) {
  c.assertType(input, "array", "borkLayoutClaim.input");
  c.assertType(record, "array", "borkLayoutClaim.record");
  let key, role, slot;
  input = c.clone(input);
  record = c.clone(record);
  if (!c.equal(c.get(record, "state"), "ready")) {
    throw new Error("Layout is not ready for a launch.");
  }
  borkLayoutVerify(record);
  role = c.clone(require("./terminal.js").field(input, "role"));
  slot = c.clone(c.get(input, "slot") ?? null);
  if (!c.in_array(role, ["master", "review", "fix"], true) || !c.is_int(slot) || slot < 1 || slot > c.get(record, "plan", "concurrency")) {
    throw new Error("Invalid role or concurrency slot.");
  }
  key = c.clone(c.string(c.string(role) + c.string(":")) + c.string(slot));
  if (!c.equal(c.get(record, "resources", key, "state"), "placeholder")) {
    throw new Error("Placement is already claimed; reconcile its previous worker.");
  }
  borkLayoutIdle(record, key);
  c.set(record, ["resources", key], "+=", c.entriesArray([["task_id", require("./terminal.js").field(input, "task_id")], ["target_id", require("./terminal.js").field(input, "target_id")]]));
  if (c.equal(c.get(record, "driver"), "hc")) {
    c.set(record, ["resources", key, "run_id"], "=", require("./terminal.js").field(input, "run_id"));
  }
  c.set(record, ["resources", key, "state"], "=", "claimed");
  borkLayoutWrite(require("./terminal.js").field(input, "record"), record);
  return c.get(record, "resources", key);
}
/** Release a placement only after its result and stopped descendants are verified. */
function borkLayoutRelease(input, record) {
  c.assertType(input, "array", "borkLayoutRelease.input");
  c.assertType(record, "array", "borkLayoutRelease.record");
  let key, resource, result, resultPath;
  input = c.clone(input);
  record = c.clone(record);
  if (!c.equal(c.get(input, "results_verified") ?? false, true) || !c.equal(c.get(input, "descendants_stopped") ?? false, true) || !c.equal(c.get(input, "worker_stopped") ?? false, true)) {
    throw new Error("Release requires accepted results and stopped worker/descendants.");
  }
  borkLayoutVerify(record);
  key = c.clone(require("./terminal.js").field(input, "placement"));
  resource = c.clone(c.get(record, "resources", key) ?? []);
  if (!c.equal(c.get(resource, "state") ?? null, "claimed") || !c.equal(c.get(resource, "task_id") ?? null, require("./terminal.js").field(input, "task_id"))) {
    throw new Error("Release identity does not match the claimed task.");
  }
  resultPath = c.clone(require("./terminal.js").field(input, "result_path"));
  result = c.clone(require("./terminal.js").readInput(resultPath));
  if (!c.in_array(c.get(result, "status") ?? null, ["complete", "good", "blocked"], true)) {
    throw new Error("Release requires a durable terminal role result.");
  }
  c.append(record, ["history"], c.entriesArray([["placement", key], ["resource", resource], ["result_path", resultPath]]));
  c.set(record, ["resources", key], "=", c.array_intersect_key(resource, c.array_flip(["id", "idle_pid", "idle_command", "terminal", "created_ms", "actual_cells"])));
  c.set(record, ["resources", key, "state"], "=", "placeholder");
  borkLayoutWrite(require("./terminal.js").field(input, "record"), record);
  return c.get(record, "resources", key);
}
/** Move focus off a closing owned leaf while preserving unrelated user navigation. */
function borkLayoutCleanupFocus(record, id) {
  const snapshot = borkLayoutSnapshot(record);
  if (snapshot.focus !== id) return;
  const context = record.context;
  if (record.driver === 'tmux') {
    require('./layout-adapters/tmux.js').borkLayoutTmux(context, ['select-pane', '-t', record.coordinator]);
  } else if (record.driver === 'hc') {
    require('./layout-adapters/hc-app.js').borkLayoutAppCommand(context, 'pane.focus', {pane: record.coordinator});
  } else if (record.driver === 'herdr') {
    /* Every worker has an owned neighbor to its left in the recorded fixed tree. */
    require('./layout-adapters/herdr.js').borkLayoutHerdr(context, ['pane', 'focus', '--pane', id, '--direction', 'left']);
    const focused = borkLayoutSnapshot(record).focus;
    if (!Object.values(record.resources).some(resource => resource.id === focused && resource.id !== id)) {
      throw new Error('Closing pane has no verified surviving owned focus target.');
    }
  }
}
/** Remove only idle owned leaves, keeping the coordinator and all surrounding panes. */
function borkLayoutCleanup(input, record) {
  c.assertType(input, "array", "borkLayoutCleanup.input");
  c.assertType(record, "array", "borkLayoutCleanup.record");
  let id, key, path, resource, snapshot;
  input = c.clone(input);
  record = c.clone(record);
  if (!c.equal(c.get(input, "results_verified") ?? false, true) || !c.equal(c.get(input, "descendants_stopped") ?? false, true)) {
    throw new Error("Cleanup requires accepted results and stopped descendants.");
  }
  for (const [_key, _value] of c.entries(c.get(record, "resources"))) {
    key = _key;
    resource = c.clone(_value);
    {
      if (!c.equal(key, "coordinator") && !c.equal(c.get(resource, "state"), "placeholder")) {
        throw new Error("A role is still claimed; release it after verifying worker shutdown.");
      }
    }
  }
  borkLayoutVerify(record, false);
  for (const [_key, _value] of c.entries(c.array_keys(c.get(record, "resources")))) {
    key = c.clone(_value);
    {
      if (!c.equal(key, "coordinator")) {
        borkLayoutIdle(record, key);
      }
    }
  }
  path = c.clone(require("./terminal.js").field(input, "record"));
  c.set(record, ["state"], "=", "cleaning");
  borkLayoutWrite(path, record);
  if (c.equal(c.get(record, "driver"), "screen")) {
    return require("./layout-adapters/screen.js").borkLayoutScreenCleanup(record, path);
  }
  for (const [_key, _value] of c.entries(c.array_reverse(c.array_keys(c.get(record, "resources"))))) {
    key = c.clone(_value);
    {
      if (c.equal(key, "coordinator")) {
        continue;
      }
      id = c.clone(c.get(record, "resources", key, "id"));
      borkLayoutCleanupFocus(record, id);
      c.set(record, ["pending"], "=", c.entriesArray([["close", key], ["id", id]]));
      borkLayoutWrite(path, record);
      if (c.equal(c.get(record, "driver"), "tmux")) {
        require("./layout-adapters/tmux.js").borkLayoutTmux(c.get(record, "context"), ["kill-pane", "-t", id]);
      } else if (c.equal(c.get(record, "driver"), "hc")) {
        require("./layout-adapters/hc-app.js").borkLayoutAppCommand(c.get(record, "context"), "pane.close", c.entriesArray([["pane", id]]));
        require("./layout-adapters/hc-app.js").borkLayoutAppAwait(c.get(record, "context"), c.get(record, "coordinator"), function (tree) {
          tree = c.clone(tree);
          return c.equal(require("./layout-adapters/hc-app.js").borkLayoutAppFind(c.get(tree, "root"), id), null);
        });
      } else {
        require("./layout-adapters/herdr.js").borkLayoutHerdr(c.get(record, "context"), ["pane", "close", id]);
      }
      c.set(record, ["resources", key], "DELETE", null);
      c.set(record, ["pending"], "=", null);
      borkLayoutWrite(path, record);
      borkLayoutVerify(record, false);
    }
  }
  snapshot = c.clone(borkLayoutSnapshot(record));
  require("./layout-plan.js").borkLayoutGeometry(c.get(record, "original", "panes", c.get(record, "coordinator")), c.get(snapshot, "panes", c.get(record, "coordinator")), c.equal(c.get(record, "driver"), "herdr") ? 1 : 0);
  c.set(record, ["state"], "=", "cleaned");
  borkLayoutWrite(path, record);
  return c.entriesArray([["state", "cleaned"], ["coordinator", c.get(record, "coordinator")]]);
}
/** Serialize mutations across target masters and concurrent goodcode owners. */
function borkLayoutAction(action, input) {
  c.assertType(action, "string", "borkLayoutAction.action");
  c.assertType(input, "array", "borkLayoutAction.input");
  if (action === 'plan') return borkLayoutPlan(input.concurrency ?? 1, input.area ?? []);
  if (action === 'preflight') return borkLayoutPreflight(input);
  return c.lockedCommand(field(input, 'record') + '.lock', __filename, ['--locked', action], input);
}

/** Dispatch a layout action only while the owning CLI holds the journal lock. */
function layoutDispatch(action, input) {
  if (action === 'create') return borkLayoutCreate(input);
  const record = require('./terminal.js').readInput(field(input, 'record'));
  switch (action) {
    case 'inspect':
      return {
        record,
        snapshot: borkLayoutSnapshot(record)
      };
    case 'claim':
      return borkLayoutClaim(input, record);
    case 'release':
      return borkLayoutRelease(input, record);
    case 'bind':
      return require('./layout-adapters/hc-app.js').borkLayoutAppBind(input, record);
    case 'cleanup':
      return borkLayoutCleanup(input, record);
    default:
      throw new Error('Unknown layout action.');
  }
}
module.exports = {
  borkLayoutWrite,
  borkLayoutSnapshot,
  borkLayoutVerify,
  borkLayoutPreflight,
  borkLayoutCreate,
  borkLayoutIdle,
  borkLayoutClaim,
  borkLayoutRelease,
  borkLayoutCleanup,
  borkLayoutAction
};
if (require.main === module) {
  try {
    const result = process.argv[2] === '--locked' ? layoutDispatch(process.argv[3], c.json_decode(require('node:fs').readFileSync(0, 'utf8'))) : borkLayoutAction(process.argv[2] ?? '', require('./terminal.js').readInput(process.argv[3] ?? ''));
    process.stdout.write(c.json_encode({
      ok: true,
      result
    }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      event: 'blocked',
      error: error.message
    }) + '\n');
    process.exitCode = 1;
  }
}
