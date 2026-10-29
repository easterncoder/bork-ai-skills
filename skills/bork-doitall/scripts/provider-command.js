'use strict';

const c = require("../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };

/** Classify provider mode while respecting option operands and prompt boundaries. */
function providerCommandMode(argv) {
  c.assertType(argv, "array", "providerCommandMode.argv");
  let arg, claudeValueOptions, codex, count, hasPositional, i, noDaemon, valueOptions;
  argv = c.clone(argv);
  codex = c.clone(c.in_array(c.strtolower(c.basename(c.get(argv, 0))), ["codex", "codex.exe"], true));
  valueOptions = c.clone(["-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env", "-i", "--image", "-m", "--model", "--local-provider", "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval"]);
  claudeValueOptions = c.clone(["--model", "--agent", "--agents", "--append-system-prompt", "--autocompact", "--debug-file", "--effort", "--environment", "--fallback-model", "--input-format", "--json-schema", "--max-budget-usd", "-n", "--name", "--output-format", "--permission-mode", "--permission-prompts", "--plugin-dir", "--plugin-url", "--remote-control-session-name-prefix", "--session-id", "--setting-sources", "--settings", "--system-prompt", "--system-prompt-snapshot"]);
  noDaemon = false;
  hasPositional = false;
  for (i = 1, count = c.clone(c.count(argv)); i < count; i = c.add(i, 1)) {
    arg = c.clone(c.get(argv, i));
    if (c.equal(arg, "--")) {
      break;
    }
    if (c.equal(arg, "--no-daemon")) {
      noDaemon = true;
    }
    if (c.equal(arg, "--print") || !c.truth(codex) && c.equal(arg, "-p")) {
      return c.entriesArray([["interactive", false], ["no_daemon", noDaemon]]);
    }
    if (c.in_array(arg, c.truth(codex) ? valueOptions : claudeValueOptions, true)) {
      i = c.add(i, 1);
      continue;
    }
    if (c.str_starts_with(arg, "-")) {
      continue;
    }
    if (!c.truth(hasPositional) && c.in_array(arg, ["exec", "e", "review", "app-server", "exec-server"], true)) {
      return c.entriesArray([["interactive", false], ["no_daemon", noDaemon]]);
    }
    hasPositional = true;
  }
  return c.entriesArray([["interactive", true], ["no_daemon", noDaemon]]);
}

/** Enforce embedded Codex execution across terminal launchers. */
function validateProviderCommand(argv) {
  c.assertType(argv, "array", "validateProviderCommand.argv");
  const mode = providerCommandMode(argv);
  if (c.in_array(c.strtolower(c.basename(c.get(argv, 0))), ["codex", "codex.exe"], true) && !c.get(mode, "no_daemon")) {
    throw new Error("Codex requires --no-daemon as a launch option; verify support with codex --help.");
  }
  return mode;
}
module.exports = {
  providerCommandMode,
  validateProviderCommand
};
