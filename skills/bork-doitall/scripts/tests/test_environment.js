'use strict';

const {
  fs,
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
  product,
  json,
  join,
  quote,
  shellJoin
} = require('../../../../tests/support.js');
/* Environment selection fixtures and isolated live tmux membership checks. */
var HELPER = P(P(__filename).resolve().parents[1]).join("environment.js");
var CAPACITY = Object.fromEntries(["native", "tmux", "herdr"].map(name => [name, {
  supported: true,
  evidence: "Fixture host capacity verified"
}]));
var RUNNER = "\nconst {detectEnvironment, selectEnvironment} = require(process.argv[1]);\nconst x = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));\ntry {\n const env = key => x.env[key] ?? false;\n const run = args => {const key=args.join(' '); if (!(key in x.commands)) throw new Error('Unexpected discovery: '+key); return x.commands[key];};\n const ancestor = pid => (x.ancestors ?? []).includes(pid);\n const contexts=detectEnvironment(env,run,ancestor,x.expected_environment ?? null);\n console.log(require(require(\"node:path\").resolve(require(\"node:path\").dirname(process.argv[1]), \"../../bork-review/scripts/support.js\")).json_encode({ok:true,result:selectEnvironment(contexts,x.capabilities)}));\n} catch(error) {console.log(require(require(\"node:path\").resolve(require(\"node:path\").dirname(process.argv[1]), \"../../bork-review/scripts/support.js\")).json_encode({ok:false,error:error.message}));}\n\n";
class EnvironmentTests extends Fixture {
  /* Exercise actual selection and detection with injected read-only commands. */
  fixture({
    herdr = false,
    tmux = false
  } = {}) {
    /* Build responses matching the installed Herdr 0.9.5 schema and tmux format. */
    var data = {
      env: {},
      commands: {},
      ancestors: [123],
      capabilities: CAPACITY
    };
    if (herdr) {
      Object.assign(data.env, {
        "HERDR_ENV": "1",
        "HERDR_PANE_ID": "w1:p2",
        "HERDR_TAB_ID": "w1:t1",
        "HERDR_WORKSPACE_ID": "w1",
        "HERDR_SOCKET_PATH": "/tmp/herdr.sock"
      });
      data.commands["herdr pane current --current"] = json({
        id: "1",
        result: {
          type: "pane_current",
          pane: {
            pane_id: "w1:p2",
            tab_id: "w1:t1",
            workspace_id: "w1"
          }
        }
      });
      data.commands["herdr pane process-info --current"] = json({
        id: "2",
        result: {
          type: "pane_process_info",
          process_info: {
            pane_id: "w1:p2",
            shell_pid: 123
          }
        }
      });
    }
    if (tmux) {
      Object.assign(data.env, {
        "TMUX": "/tmp/named,456,0",
        "TMUX_PANE": "%3"
      });
      data.commands["tmux -S /tmp/named display-message -p -t %3 #{pane_id}|#{pane_pid}|#{socket_path}|#{pid}|#{session_id}"] = "%3|123|/tmp/named|456|$0";
    }
    return data;
  }
  call(data) {
    /* Evaluate JavaScript functions directly without allowing a fixture CLI override. */
    var result = run([process.execPath, "-e", RUNNER, String(HELPER)], {
      "input": json(data),
      "text": true,
      "capture_output": true,
      "check": true,
      "timeout": 10
    });
    return JSON.parse(result.stdout);
  }
  test_matrix_and_capability_never_reorders() {
    /* All memberships select deterministically, even with insufficient native capacity. */
    for (var [herdr, tmux, native] of product([false, true], {
      "repeat": 3
    })) {
      var data = this.fixture({
        "herdr": herdr,
        "tmux": tmux
      });
      data.capabilities = {
        ...CAPACITY,
        native: {
          supported: native,
          evidence: "fixture",
          blocker: "native slots missing"
        }
      };
      var selected = herdr ? "herdr" : tmux ? "tmux" : "native";
      var result = this.call(data);
      this.assertEqual(result.ok, !(selected === "native") || native);
      if (result.ok) {
        this.assertEqual(result.result.execution_driver, selected);
      } else {
        this.assertIn("Selected driver native is blocked", result.error);
      }
    }
  }
  test_installed_inactive_tools_are_never_probed() {
    /* No membership signal selects native without any terminal command. */
    this.assertEqual(this.call(this.fixture()).result.execution_driver, "native");
  }
  test_invalid_explicit_context_blocks() {
    /* Partial, stale, non-ancestor and unreachable contexts cannot fall through. */
    for (var env of [{
      HERDR_ENV: "0"
    }, {
      HERDR_PANE_ID: "w1:p2"
    }, {
      TMUX: "/tmp/stale,1,0"
    }, {
      TMUX_PANE: "%1"
    }]) {
      var data = this.fixture();
      data.env = env;
      this.assertFalse(this.call(data).ok);
    }
    for (var [herdr, tmux] of [[true, false], [false, true], [true, true]]) {
      data = this.fixture({
        "herdr": herdr,
        "tmux": tmux
      });
      data.ancestors = [];
      this.assertFalse(this.call(data).ok);
      data = this.fixture({
        "herdr": herdr,
        "tmux": tmux
      });
      data.commands = {};
      this.assertFalse(this.call(data).ok);
    }
  }
  test_reported_membership_cannot_silently_select_another_driver() {
    /* Hidden caller context blocks even when a different driver has capacity. */
    for (var expected of ["herdr", "tmux"]) {
      var data = this.fixture({
        "tmux": expected === "herdr"
      });
      data.expected_environment = expected;
      var result = this.call(data);
      this.assertFalse(result.ok, result);
      this.assertIn("not visible to this tool process", result.error);
    }
  }
  test_reported_membership_still_requires_live_verification() {
    /* An expectation is a guard, never a substitute for membership evidence. */
    for (var expected of ["herdr", "tmux"]) {
      var data = this.fixture({
        "herdr": expected === "herdr",
        "tmux": expected === "tmux"
      });
      data.expected_environment = expected;
      var result = this.call(data);
      this.assertTrue(result.ok, result);
      this.assertEqual(result.result.execution_driver, expected);
      data.ancestors = [];
      this.assertFalse(this.call(data).ok);
    }
    data = this.fixture();
    data.expected_environment = "unknown";
    this.assertFalse(this.call(data).ok);
  }
  test_cli_reports_hidden_caller_context() {
    /* The public JSON interface preserves the expectation before selection. */
    var env = environmentWithout({keys: ["TMUX", "TMUX_PANE"], prefixes: ["HERDR_"]});
    var _temp110 = temporary({
      "prefix": "no-codex-frontend-"
    });
    try {
      var directory = _temp110.name;
      var result = run([process.execPath, String(HELPER)], {
        "input": json({
          expected_environment: "herdr",
          capabilities: CAPACITY
        }),
        "cwd": directory,
        "env": env,
        "text": true,
        "capture_output": true,
        "timeout": 10
      });
    } finally {
      _temp110.cleanup();
    }
    this.assertEqual(result.status, 1);
    this.assertRegex(JSON.parse(result.stdout).error, "(Reported herdr membership is not visible|Cannot uniquely resolve the reported herdr caller)");
  }
  test_frontend_recovery_uses_unique_same_user_cwd_and_identity() {
    /* Recover only caller variables and reject competing or mismatched frontends. */
    var runner = "\nconst {recoverTerminalFrontend}=require(require('node:path').join(require('node:path').dirname(process.argv[1]),'terminal-context.js'));\ntry {console.log(require(require(\"node:path\").resolve(require(\"node:path\").dirname(process.argv[1]), \"../../bork-review/scripts/support.js\")).json_encode({ok:true,frontend:recoverTerminalFrontend(process.argv[2],process.argv[3],Number(process.argv[4]),process.argv[5])}));}\ncatch(error){console.log(require(require(\"node:path\").resolve(require(\"node:path\").dirname(process.argv[1]), \"../../bork-review/scripts/support.js\")).json_encode({ok:false,error:error.message}));}\n\n";
    var _temp126 = temporary({
      "prefix": "frontend-proc-"
    });
    try {
      var directory = _temp126.name;
      var root = P(directory);
      var cwd = P(root).join("work");
      cwd.mkdir();
      var executable = P(root).join("codex");
      executable.touch();
      const frontend = (pid, args, env, {
        working_directory = cwd
      } = {}) => {
        /* Create only the procfs fields consumed by frontend recovery. */
        var childProcess = P(root).join(String(pid));
        childProcess.mkdir();
        P(childProcess).join("exe").symlinkTo(executable);
        P(childProcess).join("cwd").symlinkTo(working_directory);
        P(childProcess).join("cmdline").writeBytes(Buffer.concat([join(Buffer.from("\u0000", "latin1"), args.map(arg => Buffer.from(String(arg)))), Buffer.from("\u0000", "latin1")]));
        P(childProcess).join("stat").writeText(String(pid) + " (codex) " + join(" ", ["S"].concat(Array.from({
          length: 18
        }).fill("0")).concat(["12345"])));
        P(childProcess).join("environ").writeBytes(join(Buffer.from("\u0000", "latin1"), Object.entries(env).map(([key, value]) => Buffer.from(String(String(key) + "=" + String(value))))));
        return childProcess;
      };
      const recover = ({
        owner = process.getuid(),
        working_directory = cwd,
        expected = "herdr"
      } = {}) => {
        /* Call production recovery against an isolated process inventory. */
        var result = run([process.execPath, "-e", runner, String(HELPER), String(root), String(working_directory), String(owner), expected], {
          "capture_output": true,
          "text": true,
          "check": true
        });
        return JSON.parse(result.stdout);
      };
      var context = this.fixture({
        "herdr": true
      }).env;
      var childProcess = frontend(100, ["codex", "resume", "--last"], {
        ...context,
        SECRET: "never-copy"
      });
      frontend(101, ["codex", "app-server"], context);
      var result = recover();
      this.assertTrue(result.ok, result);
      this.assertEqual(result.frontend, {
        pid: 100,
        start_time: "12345",
        environment: context
      });
      P(childProcess).join("cmdline").writeBytes(Buffer.from("codex\u0000--no-daemon\u0000-p\u0000review\u0000task\u0000", "latin1"));
      this.assertEqual(recover().frontend.pid, 100);
      P(childProcess).join("cmdline").writeBytes(Buffer.from("codex\u0000--no-daemon\u0000review\u0000", "latin1"));
      this.assertFalse(recover().ok);
      P(childProcess).join("cmdline").writeBytes(Buffer.from("codex\u0000resume\u0000--last\u0000", "latin1"));
      this.assertFalse(recover({
        "owner": process.getuid() + 1
      }).ok);
      this.assertFalse(recover({
        "working_directory": root
      }).ok);
      var competitor = frontend(102, ["codex"], {});
      this.assertFalse(recover().ok);
      fs.rmSync(String(competitor), {
        recursive: true
      });
      P(childProcess).join("environ").writeBytes(Buffer.from("HERDR_ENV=0", "latin1"));
      this.assertFalse(recover().ok);
      var tmux_context = this.fixture({
        "tmux": true
      }).env;
      P(childProcess).join("environ").writeBytes(join(Buffer.from("\u0000", "latin1"), Object.entries(tmux_context).map(([key, value]) => Buffer.from(String(String(key) + "=" + String(value))))));
      var recovered = recover({
        "expected": "tmux"
      });
      this.assertTrue(recovered.ok, recovered);
      this.assertEqual(recovered.frontend.environment, tmux_context);
      this.assertFalse(recover().ok);
    } finally {
      _temp126.cleanup();
    }
  }
  test_shared_backend_ancestry_is_not_caller_membership() {
    /* Recognize a visible shared backend even when it inherited terminal variables. */
    var runner = "\nconst context = require(require('node:path').join(require('node:path').dirname(process.argv[1]), 'terminal-context.js'));\nconsole.log(JSON.stringify(context.terminalSharedBackend(process.argv[2], 101)));\n";
    var _temp181 = temporary({});
    try {
      var directory = _temp181.name;
      var root = P(directory);
      var executable = P(root).join("codex");
      executable.touch();
      for (var [pid, parent, args] of [[101, 100, ["node"]], [100, 1, ["codex", "app-server"]]]) {
        var childProcess = P(root).join(String(pid));
        childProcess.mkdir();
        P(childProcess).join("exe").symlinkTo(pid === 100 ? executable : P(process.execPath));
        P(childProcess).join("cmdline").writeBytes(join(Buffer.from("\u0000", "latin1"), args.map(arg => Buffer.from(String(arg)))));
        P(childProcess).join("stat").writeText(String(pid) + " (worker) S " + String(parent) + " " + join(" ", Array.from({
          length: 20
        }).fill("0")));
      }
      var result = run([process.execPath, "-e", runner, String(HELPER), String(root)], {
        "capture_output": true,
        "text": true,
        "check": true
      });
      this.assertTrue(JSON.parse(result.stdout));
      P(root).join("100/cmdline").writeBytes(Buffer.from("codex\u0000--no-daemon\u0000exec\u0000task", "latin1"));
      result = run([process.execPath, "-e", runner, String(HELPER), String(root)], {
        "capture_output": true,
        "text": true,
        "check": true
      });
      this.assertFalse(JSON.parse(result.stdout));
    } finally {
      _temp181.cleanup();
    }
  }
  test_shared_backend_without_frontend_blocks_public_discovery() {
    /* A backend with live inherited membership cannot authorize its startup pane. */
    var _temp203 = temporary({
      "prefix": "backend-no-frontend-"
    });
    try {
      var directory = _temp203.name;
      var root = P(directory);
      var socket = String(P(root).join("socket"));
      var executable = P(root).join("codex");
      var source = P(root).join("backend.c");
      var output = P(root).join("output.json");
      var inputs = P(root).join("capacity.json");
      inputs.writeText(json({
        capabilities: CAPACITY
      }));
      var node = process.execPath;
      source.writeText("#include <unistd.h>\n#include <sys/wait.h>\n/* Keep the backend visible as the discovery process ancestor. */\nint main(int argc, char **argv) {\n    if (argc != 4) return 2;\n    pid_t child = fork();\n    if (child == 0) { execlp(" + json(node) + ", " + json(node) + ", argv[2], argv[3], (char *)0); _exit(127); }\n    int result;\n    waitpid(child, &result, 0);\n    return WIFEXITED(result) ? WEXITSTATUS(result) : 1;\n}\n");
      run(["cc", String(source), "-o", String(executable)], {
        "check": true,
        "capture_output": true
      });
      var env = environmentWithout({keys: ["TMUX", "TMUX_PANE", "STY", "WINDOW", "SCREENDIR"], prefixes: ["HC_", "HERDR_"]});
      env.CODEX_THREAD_ID = "fixture-shared-backend";
      var command = shellJoin([String(executable), "app-server", String(HELPER), String(inputs)]) + " > " + quote(String(output));
      try {
        run(["tmux", "-S", socket, "new-session", "-d", "-s", "fixture", "-c", directory, command], {
          "env": env,
          "check": true,
          "capture_output": true
        });
        for (var _ of range(100)) {
          if (output.exists() && output.stat().size) {
            break;
          }
          sleep(0.02);
        }
        var result = JSON.parse(output.readText());
        this.assertFalse(result.ok, result);
        this.assertIn("shared backend", result.error);
        this.assertIn("--no-daemon", result.error);
      } finally {
        run(["tmux", "-S", socket, "kill-server"], {
          "capture_output": true
        });
      }
    } finally {
      _temp203.cleanup();
    }
  }
  test_recovered_frontend_must_descend_from_the_pane_shell() {
    /* Detached backend ancestry is replaced only by the identified caller PID. */
    var runner = "\nconst {environmentAncestor}=require(process.argv[1]);\nconst run=()=>\"900 100\\n100 50\\n50 1\\n1 0\";\nconsole.log(require(require(\"node:path\").resolve(require(\"node:path\").dirname(process.argv[1]), \"../../bork-review/scripts/support.js\")).json_encode([environmentAncestor(50,run,900),environmentAncestor(70,run,900)]));\n\n";
    var result = run([process.execPath, "-e", runner, String(HELPER)], {
      "capture_output": true,
      "text": true,
      "check": true
    });
    this.assertEqual(JSON.parse(result.stdout), [true, false]);
  }
  test_moved_herdr_caller_resolves_live_identity() {
    /* A moved caller retains its launch alias while current responses identify its live pane. */
    var data = this.fixture({
      "herdr": true
    });
    data.commands["herdr pane current --current"] = json({
      result: {
        pane: {
          pane_id: "w2:p4",
          tab_id: "w2:t3",
          workspace_id: "w2"
        }
      }
    });
    data.commands["herdr pane process-info --current"] = json({
      result: {
        process_info: {
          pane_id: "w2:p4",
          shell_pid: 123
        }
      }
    });
    var result = this.call(data);
    this.assertTrue(result.ok, result);
    var context = result.result.contexts.herdr;
    this.assertEqual([context.pane_id, context.tab_id, context.workspace_id], ["w2:p4", "w2:t3", "w2"]);
    data.ancestors = [];
    this.assertFalse(this.call(data).ok);
    data.ancestors = [123];
    data.commands["herdr pane current --current"] = json({
      result: {
        pane: {
          pane_id: "",
          tab_id: "w2:t3",
          workspace_id: "w2"
        }
      }
    });
    this.assertFalse(this.call(data).ok);
    data.commands["herdr pane current --current"] = json({
      result: {
        pane: {
          pane_id: "w2:p4",
          tab_id: "w2:t3",
          workspace_id: "w2"
        }
      }
    });
    data.commands["herdr pane process-info --current"] = json({
      result: {
        process_info: {
          pane_id: "w3:p9",
          shell_pid: 123
        }
      }
    });
    this.assertFalse(this.call(data).ok);
  }
  test_selected_driver_capability_blocks_without_fallback() {
    /* Native availability cannot rescue a selected terminal driver. */
    for (var driver of ["herdr", "tmux"]) {
      var data = this.fixture({
        "herdr": driver === "herdr",
        "tmux": driver === "tmux"
      });
      data.capabilities = {
        ...CAPACITY,
        [driver]: {
          supported: false,
          blocker: "required model unavailable"
        }
      };
      var result = this.call(data);
      this.assertFalse(result.ok);
      this.assertIn("required model unavailable", result.error);
    }
  }
  test_detached_tmux_recovery_and_context_command() {
    /* A harmless frontend fixture proves recovery and socket routing outside its pane. */
    var _temp286 = temporary({
      "prefix": "detached-tmux-"
    });
    try {
      var directory = _temp286.name;
      var root = P(directory);
      var socket = String(P(root).join("socket"));
      var frontend = P(root).join("codex");
      var source = P(root).join("frontend.c");
      source.writeText("#include <unistd.h>\n/* Keep the fixture alive for discovery. */\nint main(void) { sleep(30); return 0; }\n");
      run(["cc", String(source), "-o", String(frontend)], {
        "check": true,
        "capture_output": true
      });
      var env = environmentWithout({keys: ["TMUX", "TMUX_PANE"], prefixes: ["HERDR_"]});
      env.CODEX_THREAD_ID = "fixture-detached-thread";
      var command = "exec " + quote(String(frontend));
      try {
        run(["tmux", "-S", socket, "new-session", "-d", "-s", "fixture", "-c", directory, command], {
          "env": env,
          "check": true,
          "capture_output": true
        });
        for (var _ of range(100)) {
          var pane_pid = checkOutput(["tmux", "-S", socket, "display-message", "-p", "#{pane_pid}"], {
            "text": true
          }).trim();
          if (String(P("/proc/" + String(pane_pid) + "/exe").resolve()) === String(frontend)) {
            break;
          }
          sleep(0.02);
        }
        var result = run([process.execPath, String(HELPER)], {
          "input": json({
            capabilities: CAPACITY
          }),
          "env": {
            ...env,
            TMUX: String(P(root).join("stale")) + ",999999,0",
            TMUX_PANE: "%999"
          },
          "cwd": directory,
          "text": true,
          "capture_output": true,
          "timeout": 10
        });
        var data = JSON.parse(result.stdout);
        this.assertTrue(data.ok, data);
        this.assertEqual(data.result.execution_driver, "tmux");
        var context = data.result.contexts.tmux;
        this.assertEqual(context.socket, socket);
        this.assertEqual(context.frontend.pid, Math.trunc(Number(pane_pid)));
        var output = run([process.execPath, String(HELPER), "tmux", "display-message", "-p", "#{socket_path}"], {
          "cwd": directory,
          "env": env,
          "text": true,
          "capture_output": true,
          "timeout": 10
        });
        this.assertEqual(output.status, 0, output.stdout);
        this.assertEqual(output.stdout.trim(), socket);
      } finally {
        run(["tmux", "-S", socket, "kill-server"], {
          "capture_output": true
        });
      }
    } finally {
      _temp286.cleanup();
    }
  }
  test_live_named_socket_and_stale_inheritance() {
    /* Only the process within the live named-server pane verifies membership. */
    var _temp324 = temporary({
      "prefix": "environment-tmux-"
    });
    try {
      var directory = _temp324.name;
      var root = P(directory);
      var socket = String(P(root).join("socket"));
      var output = P(root).join("output.json");
      var inputs = P(root).join("capacity.json");
      inputs.writeText(json({
        capabilities: CAPACITY
      }));
      var command = shellJoin([process.execPath, String(HELPER), String(inputs)]) + " > " + quote(String(output)) + "; sleep 3";
      var base_env = environmentWithout({keys: ["TMUX", "TMUX_PANE"], prefixes: ["HERDR_"]});
      try {
        run(["tmux", "-S", socket, "new-session", "-d", "-s", "probe", command], {
          "env": base_env,
          "check": true,
          "capture_output": true
        });
        for (var _ of range(100)) {
          if (output.exists() && output.stat().size) {
            break;
          }
          sleep(0.02);
        }
        var result = JSON.parse(output.readText());
        this.assertTrue(result.ok, result);
        this.assertEqual(result.result.execution_driver, "tmux");
        var context = result.result.contexts.tmux;
        var stale_env = {
          ...base_env,
          TMUX: socket + "," + checkOutput(["tmux", "-S", socket, "display-message", "-p", "#{pid}"], {
            "text": true
          }).trim() + ",0",
          TMUX_PANE: context.pane_id
        };
        var stale = run([process.execPath, String(HELPER), String(inputs)], {
          "env": stale_env,
          "text": true,
          "capture_output": true
        });
        this.assertEqual(stale.status, 1);
        this.assertIn("another process", JSON.parse(stale.stdout).error);
      } finally {
        run(["tmux", "-S", socket, "kill-server"], {
          "capture_output": true
        });
      }
    } finally {
      _temp324.cleanup();
    }
  }
}
if (require.main === module) suite(EnvironmentTests, {
  "test_shared_backend_without_frontend_blocks_public_discovery": !(which("tmux") && which("cc") && P("/proc/self").exists()) ? "local procfs, tmux and a C compiler required" : false,
  "test_detached_tmux_recovery_and_context_command": !(which("tmux") && which("cc") && P("/proc/self").exists()) ? "local procfs, tmux and a C compiler required" : false,
  "test_live_named_socket_and_stale_inheritance": !(which("tmux") && which("ps")) ? "tmux and ps required" : false
});
module.exports = {
  EnvironmentTests
};
