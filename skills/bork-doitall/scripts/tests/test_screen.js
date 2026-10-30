'use strict';

const {
  privatePty
} = require('../../../../tests/fixtures/pty.js');
const {
  path: nodePath,
  P,
  environmentWithout,
  Fixture,
  suite,
  run,
  checkOutput,
  temporary,
  which,
  sleep,
  range,
  zip,
  product,
  json
} = require('../../../../tests/support.js');
/* Real GNU Screen lifecycle and caller-context checks using harmless local jobs. */
var SCRIPTS = P(__filename).resolve().parents[1];
class ScreenTests extends Fixture {
  /* Exercise isolated sessions without running an AI or contacting GitHub. */
  setUp() {
    /* Allocate a private socket directory and clear inherited terminal identities. */
    this.temp = temporary({
      "prefix": "screen-test-"
    });
    this.root = P(this.temp.name);
    this.sockets = P(this.root).join("sockets");
    this.sockets.mkdir({
      "mode": 448
    });
    this.env = environmentWithout({keys: ["TMUX", "TMUX_PANE", "STY", "WINDOW", "CODEX_THREAD_ID"], prefixes: ["HERDR_"]});
    this.env.SCREENDIR = String(this.sockets);
    this.identity = null;
    this.counter = 0;
  }
  tearDown() {
    /* Close only sessions inside the fixture's private socket directory. */
    for (var socket of this.sockets.iterdir()) {
      run(["screen", "-S", socket.name, "-X", "quit"], {
        "env": this.env,
        "capture_output": true
      });
    }
    this.temp.cleanup();
  }
  invoke(mode, data) {
    /* Call the public launcher with a fresh immutable input file. */
    this.counter += 1;
    var source = P(this.root).join("input-" + String(this.counter) + ".json");
    source.writeText(json(data));
    var result = run([process.execPath, String(P(SCRIPTS).join("screen.js")), mode, String(source)], {
      "env": this.env,
      "text": true,
      "capture_output": true,
      "timeout": 10
    });
    return JSON.parse(result.stdout);
  }
  launch({
    code = "console.log(\"visible fixture\");",
    role = "master",
    name = "fixture"
  } = {}) {
    /* Prepare and launch a harmless Node.js job through the shared runner. */
    var record = P(this.root).join("exit-" + String(name) + ".json");
    var job = P(this.root).join("job-" + String(name) + ".json");
    job.writeText(json({
      argv: [process.execPath, "-e", code],
      exit_record: String(record)
    }));
    var data = {
      role: role,
      cwd: String(this.root),
      job: String(job),
      session_name: name,
      socket_dir: String(this.sockets)
    };
    var result = this.invoke("launch", data);
    if (result.ok) {
      this.identity = result.result;
    }
    return [result, record];
  }
  wait_record(record) {
    /* Wait briefly for atomic process exit evidence. */
    for (var _ of range(100)) {
      if (record.exists()) {
        return JSON.parse(record.readText());
      }
      sleep(0.02);
    }
    this.fail("Exit record was not published");
  }
  test_session_identity_validation() {
    /* Accept dotted default identities while rejecting ambiguous or malformed selectors. */
    const {screenSessionPid} = require('../screen-context.js');
    const assert = require('node:assert/strict');
    for (const session of ['123.fixture', '884160.pts-0.wolfman']) {
      this.assertEqual(screenSessionPid(session), session.split('.')[0]);
    }
    for (const session of ['fixture', '0.fixture', '123.', '123.bad/name', '123.bad name', '123.fixture\n', '123.fixture\0', '-S', null]) {
      assert.throws(() => screenSessionPid(session), /Screen session identity/);
    }
  }
  test_selection_priority_capacity_and_legacy_records() {
    /* Screen follows active tmux and blocks capacity failure without fallback. */
    var runner = "\nconst {selectEnvironment,validateEnvironmentSelection}=require(process.argv[1]);\nconst x=JSON.parse(require('node:fs').readFileSync(0,'utf8'));\ntry {const selection=selectEnvironment(x.contexts,x.capabilities);validateEnvironmentSelection({execution_driver:selection.execution_driver,environment_selection:selection});console.log(require(require(\"node:path\").resolve(require(\"node:path\").dirname(process.argv[1]), \"../../bork-review/scripts/support.js\")).json_encode({ok:true,driver:selection.execution_driver}));}\ncatch(error){console.log(require(require(\"node:path\").resolve(require(\"node:path\").dirname(process.argv[1]), \"../../bork-review/scripts/support.js\")).json_encode({ok:false,error:error.message}));}\n\n";
    for (var [herdr, tmux, screen] of product([false, true], {
      "repeat": 3
    })) {
      var contexts = Object.fromEntries(zip(["herdr", "tmux", "screen"], [herdr, tmux, screen]).map(([name, active]) => [name, {
        active: active,
        pane_id: "0",
        socket: "123.fixture",
        shell_pid: 123
      }]));
      var selected = herdr ? "herdr" : tmux ? "tmux" : screen ? "screen" : "native";
      for (var supported of [true, false]) {
        var payload = {
          contexts: contexts,
          capabilities: {
            [selected]: {
              supported: supported,
              evidence: "fixture"
            }
          }
        };
        var output = checkOutput([process.execPath, "-e", runner, String(P(SCRIPTS).join("environment.js"))], {
          "input": json(payload),
          "text": true,
          "env": this.env
        });
        var result = JSON.parse(output);
        this.assertEqual(result.ok, supported, result);
        if (supported) {
          this.assertEqual(result.driver, selected);
        }
      }
    }
  }
  test_read_query_retries_after_owned_timeout() {
    /* Retry a hung read without replaying mutations on a private tty. */
    const binary = this.root.join('bin');
    binary.mkdir();
    const fake = binary.join('screen'),
      count = this.root.join('calls');
    fake.writeText('#!' + process.execPath + `
const fs=require("node:fs");const file=process.env.SCREEN_CALLS;const count=fs.existsSync(file)?Number(fs.readFileSync(file,"utf8"))+1:1;fs.writeFileSync(file,String(count));if(count===1)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,6000);console.log("Remove dead screens with 'screen -wipe'.".repeat(2));console.log("0 (coordinator)");
`);
    fake.chmod(0o700);
    for (const args of [['-Q', 'number'], ['-p', '0', '-Q', 'title']]) {
      count.unlink({
        missing_ok: true
      });
      const resultFile = this.root.join('retry.json');
      const code = `const fs=require('node:fs');const screen=require(process.argv[1]);const tty=fs.readlinkSync('/proc/self/fd/0');let result;try{result={ok:true,value:screen.borkLayoutScreen({session:'123.fixture',window_tty:tty},JSON.parse(process.argv[2]))}}catch(error){result={ok:false,error:error.message}}fs.writeFileSync(process.argv[3],JSON.stringify(result));`;
      const pty = privatePty([process.execPath, '-e', code, String(SCRIPTS.join('layout-adapters/screen.js')), json(args), String(resultFile)], {
        env: {
          ...this.env,
          PATH: String(binary) + nodePath.delimiter + this.env.PATH,
          SCREEN_CALLS: String(count)
        }
      });
      try {
        this.assertEqual(pty.child.wait({
          timeout: 10
        }), 0);
        this.assertEqual(JSON.parse(resultFile.readText()), {
          ok: true,
          value: '0 (coordinator)'
        });
        this.assertEqual(count.readText(), '2');
      } finally {
        pty.cleanup();
      }
    }
  }
  test_context_discovers_inherited_tty_without_environment() {
    /* A dotted Screen identity supports display discovery and lifecycle queries without TTY. */
    const resultFile = this.root.join('tty-context.json');
    const code = `const fs=require('node:fs');const screen=require(process.argv[1]);let result;try{result=screen.borkLayoutScreenContext({session:process.env.STY,socket_dir:process.env.SCREENDIR},process.env.WINDOW);result.query=require(process.argv[3]).screenCommand({session:process.env.STY,pane:process.env.WINDOW,socket_dir:process.env.SCREENDIR},['-Q','number'])}catch(error){result={error:error.message}}fs.writeFileSync(process.argv[2],JSON.stringify(result));`;
    const env = {
      ...this.env,
      TERM: 'xterm-256color'
    };
    delete env.TTY;
    const pty = privatePty(['screen', '-m', '-S', 'pts-0.ttycontext', process.execPath, '-e', code, String(SCRIPTS.join('layout-adapters/screen.js')), String(resultFile), String(SCRIPTS.join('screen.js'))], {
      env
    });
    try {
      for (let attempt = 0; attempt < 200 && !resultFile.exists(); attempt++) sleep(.1);
      this.assertTrue(resultFile.exists(), 'Private Screen context probe did not finish');
      const context = JSON.parse(resultFile.readText());
      this.assertNotIn('error', context, json(context));
      this.assertTrue(context.query.startsWith('0 ('));
      this.assertTrue(context.window_tty.startsWith('/dev/pts/'));
      this.assertTrue(context.display_tty.startsWith('/dev/pts/'));
    } finally {
      run(['screen', '-S', 'pts-0.ttycontext', '-X', 'quit'], {
        env,
        timeout: 5
      });
      pty.cleanup();
    }
  }
  test_detached_frontend_recovery_and_context_command() {
    /* Recover Screen context for a unique frontend and route later queries. */
    var source = P(this.root).join("frontend.c");
    var frontend = P(this.root).join("codex");
    source.writeText("#include <unistd.h>\n/* Retain a harmless interactive fixture. */\nint main(void) { sleep(30); return 0; }\n");
    run(["cc", String(source), "-o", String(frontend)], {
      "check": true,
      "capture_output": true
    });
    var job = P(this.root).join("job.json");
    job.writeText(json({
      argv: [String(frontend), "--no-daemon"],
      exit_record: String(P(this.root).join("exit.json"))
    }));
    var result = this.invoke("launch", {
      role: "master",
      cwd: String(this.root),
      job: String(job),
      session_name: "frontend",
      socket_dir: String(this.sockets)
    });
    this.assertTrue(result.ok, result);
    var env = {
      ...this.env,
      CODEX_THREAD_ID: "fixture"
    };
    for (var _ of range(100)) {
      var output = run([process.execPath, String(P(SCRIPTS).join("environment.js"))], {
        "env": env,
        "cwd": this.root,
        "input": json({
          expected_environment: "screen",
          capabilities: {
            screen: {
              supported: true,
              evidence: "fixture"
            }
          }
        }),
        "text": true,
        "capture_output": true,
        "timeout": 10
      });
      var data = JSON.parse(output.stdout);
      if (data.ok) {
        break;
      }
      sleep(0.02);
    }
    this.assertTrue(data.ok, data);
    var context = data.result.contexts.screen;
    this.assertEqual(context.socket_dir, String(this.sockets));
    this.assertIn("frontend", context);
    var command = run([process.execPath, String(P(SCRIPTS).join("environment.js")), "screen", "-Q", "number"], {
      "cwd": this.root,
      "env": env,
      "capture_output": true,
      "text": true,
      "timeout": 10
    });
    this.assertEqual(command.status, 0, command.stdout);
    this.assertTrue(command.stdout.startsWith("0 ("), command.stdout);
  }
  test_roles_persistence_capture_and_cleanup() {
    /* Each role retains output and exit evidence until its owned session is closed. */
    for (var role of ["master", "review", "fix"]) {
      var [result, record] = this.launch({
        "role": role,
        "name": role
      });
      this.assertTrue(result.ok, result);
      var identity = result.result;
      this.assertEqual(identity.role, role);
      this.assertEqual(this.wait_record(record).exit_code, 0);
      this.assertTrue(this.invoke("inspect", identity).ok);
      var output = P(this.root).join(String(role) + ".txt");
      this.assertTrue(this.invoke("capture", {
        ...identity,
        output: String(output)
      }).ok);
      for (var _ of range(100)) {
        if (output.exists()) {
          break;
        }
        sleep(0.02);
      }
      this.assertIn("visible fixture", output.readText());
      this.assertTrue(this.invoke("close", identity).ok);
      this.assertFalse(this.invoke("inspect", identity).ok);
    }
  }
  test_invalid_role_collision_and_independent_sessions() {
    /* Reject unsupported roles and prevent duplicate names while preserving workers. */
    var [result, _] = this.launch({
      "role": "prify"
    });
    this.assertFalse(result.ok);
    var [first, _] = this.launch({
      "name": "review"
    });
    this.assertTrue(first.ok, first);
    var [duplicate, _] = this.launch({
      "name": "review"
    });
    this.assertFalse(duplicate.ok);
    var [second, _] = this.launch({
      "name": "fix"
    });
    this.assertTrue(second.ok, second);
    this.assertNotEqual(first.result.session, second.result.session);
    this.assertTrue(this.invoke("inspect", first.result).ok);
  }
  test_interrupt_publishes_nonzero_exit() {
    /* Deliver terminal Ctrl-C and retain the interrupted job's exit evidence. */
    var [result, record] = this.launch({
      "code": "console.log(\"ready\"); setTimeout(()=>{},30000);"
    });
    this.assertTrue(result.ok, result);
    sleep(0.15);
    this.assertTrue(this.invoke("interrupt", this.identity).ok);
    this.assertNotEqual(this.wait_record(record).exit_code, 0);
  }
  test_live_membership_and_copied_context() {
    /* Accept the actual Screen child and reject copied or stale window identities. */
    var output = P(this.root).join("membership.json");
    var input_path = P(this.root).join("capacity.json");
    input_path.writeText(json({
      expected_environment: "screen",
      capabilities: {
        screen: {
          supported: true,
          evidence: "fixture capacity"
        }
      }
    }));
    var code = "const fs=require(\"node:fs\");const fd=fs.openSync(" + json(String(output)) + ",\"w\"); require(\"node:child_process\").spawnSync(" + json(process.execPath) + "," + json([String(P(SCRIPTS).join("environment.js")), String(input_path)]) + ",{stdio:[\"ignore\",fd,\"inherit\"]});fs.closeSync(fd);setTimeout(()=>{},10000);";
    var [result, _] = this.launch({
      "code": code
    });
    this.assertTrue(result.ok, result);
    for (var _ of range(100)) {
      if (output.exists() && output.stat().size) {
        break;
      }
      sleep(0.02);
    }
    var membership = JSON.parse(output.readText());
    this.assertTrue(membership.ok, membership);
    this.assertEqual(membership.result.execution_driver, "screen");
    var env = {
      ...this.env,
      STY: this.identity.session,
      WINDOW: "0"
    };
    var copied = run([process.execPath, String(P(SCRIPTS).join("environment.js")), String(input_path)], {
      "env": env,
      "capture_output": true,
      "text": true,
      "timeout": 10
    });
    this.assertEqual(copied.status, 1);
    this.assertIn("another process", JSON.parse(copied.stdout).error);
  }
}
if (require.main === module) suite(ScreenTests, {
  "test_selection_priority_capacity_and_legacy_records": !(which("screen") && P("/proc/self").exists()) ? "GNU Screen and procfs required" : false,
  "test_read_query_retries_after_owned_timeout": (!which("cc") ? "C compiler required for private PTY" : false) || (!(which("screen") && P("/proc/self").exists()) ? "GNU Screen and procfs required" : false),
  "test_context_discovers_inherited_tty_without_environment": (!which("cc") ? "C compiler required for private PTY" : false) || (!(which("screen") && P("/proc/self").exists()) ? "GNU Screen and procfs required" : false),
  "test_detached_frontend_recovery_and_context_command": (!(which("screen") && P("/proc/self").exists()) ? "GNU Screen and procfs required" : false) || (!which("cc") ? "C compiler required" : false),
  "test_roles_persistence_capture_and_cleanup": !(which("screen") && P("/proc/self").exists()) ? "GNU Screen and procfs required" : false,
  "test_invalid_role_collision_and_independent_sessions": !(which("screen") && P("/proc/self").exists()) ? "GNU Screen and procfs required" : false,
  "test_interrupt_publishes_nonzero_exit": !(which("screen") && P("/proc/self").exists()) ? "GNU Screen and procfs required" : false,
  "test_live_membership_and_copied_context": !(which("screen") && P("/proc/self").exists()) ? "GNU Screen and procfs required" : false
});
module.exports = {
  ScreenTests
};
