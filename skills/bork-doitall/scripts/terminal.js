'use strict';

const c = require("../../bork-review/scripts/support.js");
const argv = process.argv.slice(1),
  server = {
    SCRIPT_FILENAME: process.argv[1]
  };

/** Quote a command for the verified terminal shell, independent of the invoking OS. */
function terminalCommand(args, shell) {
  c.assertType(args, "array", "terminalCommand.args");
  c.assertType(shell, "string", "terminalCommand.shell");
  let arg, escaped, quoted;
  args = c.clone(args);
  shell = c.clone(shell);
  if (!c.in_array(shell, ["posix", "powershell", "cmd"], true)) {
    throw new Error("Unsupported terminal shell.");
  }
  quoted = c.clone([]);
  for (const [_key, _value] of c.entries(args)) {
    arg = c.clone(_value);
    {
      if (!c.is_string(arg) || c.truth(c.preg_match("/[\\x00\\r\\n]/", arg))) {
        throw new Error("Invalid terminal command argument.");
      }
      if (c.equal(shell, "cmd")) {
        if (!c.equal(c.strpbrk(arg, "\"%!"), false)) {
          throw new Error("Argument cannot be represented safely in cmd; use a verified PowerShell or POSIX shell.");
        }
        c.append(quoted, [], c.string(c.string("\"") + c.string(arg)) + c.string("\""));
      } else {
        escaped = c.clone(c.equal(shell, "powershell") ? c.str_replace("'", "''", arg) : c.str_replace("'", "'\"'\"'", arg));
        c.append(quoted, [], c.string(c.string("'") + c.string(escaped)) + c.string("'"));
      }
    }
  }
  return c.string(c.equal(shell, "powershell") ? "& " : "") + c.string(c.implode(" ", quoted));
}
/** Build the shared runner invocation for the destination pane's shell. */
function runnerCommand(input, shell = "posix") {
  c.assertType(input, "string", "runnerCommand.input");
  c.assertType(shell, "string", "runnerCommand.shell");
  input = c.clone(input);
  shell = c.clone(shell);
  return terminalCommand([c.NODE_BINARY, c.string(__dirname) + c.string("/tmux.js"), "run", input], shell);
}
/** Read a regular JSON input file. */
function readInput(path) {
  c.assertType(path, "string", "readInput.path");
  let data;
  path = c.clone(path);
  if (!c.is_file(path) || c.is_link(path)) {
    throw new Error("Expected a regular input file.");
  }
  data = c.clone(c.json_decode(c.file_get_contents(path), true, 512, c.JSON_THROW_ON_ERROR));
  if (!c.is_array(data)) {
    throw new Error("Expected JSON object.");
  }
  return data;
}
/** Require a nonempty text field. */
function field(data, key) {
  c.assertType(data, "array", "field.data");
  c.assertType(key, "string", "field.key");
  data = c.clone(data);
  key = c.clone(key);
  if (!(c.get(data, key) != null) || !c.is_string(c.get(data, key)) || c.equal(c.get(data, key), "")) {
    throw new Error(c.string("Missing string: ") + c.string(key));
  }
  return c.get(data, key);
}
/** Execute an argument array without shell interpolation. */
function execute(args, acceptedCodes = [0], environment = null) {
  c.assertType(args, "array", "execute.args");
  c.assertType(acceptedCodes, "array", "execute.acceptedCodes");
  c.assertType(environment, "?array", "execute.environment");
  const result = c.processResult(args, {
    env: environment === null ? undefined : c.object(environment)
  });
  if (result.error) throw new Error('Unable to start command.');
  if (!acceptedCodes.includes(result.code)) throw new Error('Terminal command failed; reconcile before retrying.');
  return result.output.trim();
}

/** Validate a provider command without executing it or interpreting credentials. */
function validateJob(job) {
  c.assertType(job, "array", "validateJob.job");
  let arg, args;
  job = c.clone(job);
  args = c.clone(c.get(job, "argv") ?? null);
  if (!c.is_array(args) || !c.truth(args) || !c.is_string(c.get(args, 0)) || !c.truth(c.is_executable(c.get(args, 0)))) {
    throw new Error("CLI executable is unavailable.");
  }
  for (const [_key, _value] of c.entries(args)) {
    arg = c.clone(_value);
    {
      if (!c.is_string(arg) || c.str_contains(arg, "\u0000")) {
        throw new Error("CLI arguments must be strings without NUL bytes.");
      }
    }
  }
  field(job, "exit_record");
}
/** Run the selected agent with the pane's actual terminal streams. */
function runPane(launch) {
  c.assertType(launch, "array", "runPane.launch");
  const job = readInput(field(launch, 'job'));
  validateJob(job);
  const record = field(job, 'exit_record');
  const fs = require('node:fs');
  const path = require('node:path');
  if (fs.existsSync(record) || c.is_link(record) || !c.is_dir(path.dirname(record))) {
    throw new Error('Exit record exists or directory is missing.');
  }
  /* Reserve publication before launch so concurrent retries cannot start duplicate workers. */
  const reservation = record + '.runner';
  let fd;
  try {
    fd = fs.openSync(reservation, 'wx', 0o600);
  } catch {
    throw new Error('Runner already owns this exit record; reconcile before retrying.');
  }
  fs.writeFileSync(fd, JSON.stringify({
    pid: process.pid,
    argv: job.argv[0]
  }));
  fs.closeSync(fd);
  const cp = require('node:child_process');
  const os = require('node:os');
  /* Keep the runner alive long enough to retain its child's interrupted exit. */
  const interrupt = () => {};
  process.on('SIGINT', interrupt);
  const result = cp.spawnSync(job.argv[0], job.argv.slice(1), {
    cwd: field(launch, 'cwd'),
    stdio: 'inherit'
  });
  const code = result.status ?? (result.signal ? 128 + (os.constants.signals[result.signal] ?? 0) : 1);
  try {
    c.atomicWrite(record, JSON.stringify({
      exit_code: code,
      time: c.gmdate(),
      ...(result.signal ? {
        signal: result.signal
      } : {}),
      ...(result.error ? {
        spawn_error: result.error.code ?? 'spawn_failed'
      } : {})
    }), '.exit-');
    fs.unlinkSync(reservation);
  } finally {
    process.removeListener('SIGINT', interrupt);
  }
  return code;
}
module.exports = {
  terminalCommand,
  runnerCommand,
  readInput,
  field,
  execute,
  validateJob,
  runPane
};
