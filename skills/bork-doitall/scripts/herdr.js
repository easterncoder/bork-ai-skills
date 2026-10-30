'use strict';

const c = require("../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };
let error, path;

/** Submit one runner into a previously verified stable Herdr placement. */
function borkHerdrLaunch(input, path) {
  c.assertType(input, "array", "borkHerdrLaunch.input");
  c.assertType(path, "string", "borkHerdrLaunch.path");
  let cwd, foreground, key, layout, pane, placement, process, reply, runner;
  input = c.clone(input);
  path = c.clone(path);
  cwd = c.clone(require("./terminal.js").field(input, "cwd"));
  if (!c.is_dir(cwd)) {
    throw new Error("Working directory missing.");
  }
  require("./terminal.js").validateJob(require("./terminal.js").readInput(require("./terminal.js").field(input, "job")));
  runner = c.clone(require("./terminal.js").runnerCommand(path, require("./terminal.js").field(input, "shell")));
  layout = c.clone(require("./terminal.js").readInput(require("./terminal.js").field(input, "layout_record")));
  if (!c.equal(c.get(layout, "driver"), "herdr")) {
    throw new Error("Herdr launch requires a verified Herdr layout.");
  }
  require("./layout.js").borkLayoutVerify(layout);
  /** Claim only after shell preflight for legacy fixed journals. */
  function claimPlacement() {
    placement = c.clone(require("./layout.js").borkLayoutAction("claim", c.entriesArray([["record", c.get(input, "layout_record")], ["role", require("./terminal.js").field(input, "role")], ["slot", c.get(input, "slot") ?? null], ["task_id", require("./terminal.js").field(input, "task_id")], ["target_id", require("./terminal.js").field(input, "target_id")]])));
    if (!placement.id) throw new Error('Visual admission is waiting or blocked; no worker may launch.');
  }
  if (layout.version === 2) claimPlacement();

  key = c.clone(c.string(c.string(require("./terminal.js").field(input, "role")) + c.string(":")) + c.string(c.get(input, "slot") ?? ""));
  pane = c.clone(layout.version === 2 ? placement.id : c.get(layout, "resources", key, "id"));
  process = c.clone(require("./layout-adapters/herdr.js").borkLayoutHerdr(c.get(layout, "context"), ["pane", "process-info", "--pane", pane]));
  process = c.clone(c.get(process, "process_info") ?? process);
  foreground = c.clone(c.get(process, "foreground_processes") ?? []);
  if (!c.equal(c.get(process, "pane_id") ?? null, pane) || !c.is_int(c.get(process, "shell_pid") ?? null) || !c.equal(c.count(foreground), 1) || !c.equal(c.get(foreground, 0, "pid") ?? null, c.get(process, "shell_pid"))) {
    throw new Error("Herdr placement is not a verified available foreground shell.");
  }
  if (layout.version !== 2) claimPlacement();
  /* The claim remains held on an uncertain submission, preventing replay. */
  reply = c.clone(require("./layout-adapters/herdr.js").borkLayoutHerdr(c.get(layout, "context"), ["pane", "run", c.get(placement, "id"), runner]));
  return c.entriesArray([["pane", c.get(placement, "id")], ["role", c.get(input, "role")], ["slot", c.get(input, "slot")], ["layout_record", c.get(input, "layout_record")], ["submission", reply]]);
}
module.exports = {
  borkHerdrLaunch
};
if (require.main === module) {
  try {
    path = c.clone(c.realpath(c.get(argv, 2) ?? ""));
    if (!c.equal(c.get(argv, 1) ?? "", "launch") || c.equal(path, false)) {
      throw new Error("Usage: node herdr.js launch input.json");
    }
    process.stdout.write(c.string(c.string(c.json_encode(c.entriesArray([["ok", true], ["result", borkHerdrLaunch(require("./terminal.js").readInput(path), path)]]), c.JSON_THROW_ON_ERROR)) + c.string("\n")));
  } catch (error) {
    process.stdout.write(c.string(c.string(c.json_encode(c.entriesArray([["ok", false], ["event", "blocked"], ["error", error.message]]), c.JSON_INVALID_UTF8_SUBSTITUTE)) + c.string("\n")));
    c.exit(1);
  }
}
