'use strict';

const {
  P,
  Fixture,
  suite,
  run,
  temporary,
  json,
  join
} = require('../../../../tests/support.js');
/* Exercise hc discovery and durable lifecycle contracts without a shared core. */
var HELPER = P(P(__filename).resolve().parents[1]).join("environment.js");
var JS = "\nconst {detectEnvironment,selectEnvironment,validateEnvironmentSelection}=require(process.argv[1]);\nconst {hcAction}=require(require('node:path').join(require('node:path').dirname(process.argv[1]),'hc.js'));\nconst x=JSON.parse(require('node:fs').readFileSync(0,'utf8'));\nconst run=args=>{const key=args.join(' ');if(!(key in x.commands))throw new Error('Unexpected command: '+key);return x.commands[key];};\ntry {\n var result;\n if(x.mode==='detect') {const contexts=detectEnvironment(k=>x.env[k]??false,run,pid=>x.ancestors.includes(pid),x.expected??null);result=selectEnvironment(contexts,x.capabilities);validateEnvironmentSelection({execution_driver:result.execution_driver,environment_selection:result});}\n else result=hcAction(x.action,x.input,run);\n console.log(require(require(\"node:path\").resolve(require(\"node:path\").dirname(process.argv[1]), \"../../bork-review/scripts/support.js\")).json_encode({ok:true,result}));\n} catch(error){console.log(require(require(\"node:path\").resolve(require(\"node:path\").dirname(process.argv[1]), \"../../bork-review/scripts/support.js\")).json_encode({ok:false,error:error.message}));}\n\n";
class HcTests extends Fixture {
  /* Use installed-schema responses and real durable files with injected commands. */
  setUp() {
    /* Create independent immutable job and lifecycle paths for every case. */
    this.temp = temporary({});
    this.addCleanup(this.temp.cleanup);
    this.root = P(this.temp.name);
    this.record = P(this.root).join("record.json");
    this.job = P(this.root).join("job.json");
    this.job.writeText(json({
      argv: ["/bin/cat"],
      exit_record: String(P(this.root).join("exit.json"))
    }));
    this.terminal = {
      address: "t7",
      created_ms: 1234,
      pid: 123,
      state: "live",
      name: "bork-test",
      labels: {
        "bork-run": "run-1"
      },
      status: {
        state: "idle"
      }
    };
    this.commands = {
      "hc server status": json({
        core: {
          id: "core-1"
        }
      }),
      "hc get t7": json(this.terminal),
      "hc --skill": "--no-daemon first_message.sent",
      "hc --version": "hc 0.1.13"
    };
    for (var [command, flag] of Object.entries({
      run: "--bg",
      send: "--if",
      wait: "--timeout",
      get: "TERMINAL",
      read: "--lines",
      interrupt: "TERMINAL",
      kill: "TERMINAL",
      rm: "TERMINAL"
    })) {
      this.commands["hc " + String(command) + " --help"] = flag;
    }
    this.input = {
      record: String(this.record),
      job: String(this.job),
      cwd: String(this.root),
      name: "bork-test",
      role: "review",
      run_id: "run-1",
      task_id: "task-1"
    };
  }
  call(data = {}) {
    /* Run production JavaScript functions and expose failures as structured evidence. */
    var result = run([process.execPath, "-e", JS, String(HELPER)], {
      "input": json({
        commands: this.commands,
        ...data
      }),
      "text": true,
      "capture_output": true,
      "check": true,
      "timeout": 10
    });
    return JSON.parse(result.stdout);
  }
  saved(changes = {}) {
    /* Publish a previously owned terminal record for lifecycle recovery cases. */
    var record = {
      ...this.input,
      core_id: "core-1",
      terminal_id: "t7",
      created_ms: 1234,
      state: "awaiting_result",
      ...changes
    };
    this.record.writeText(json(record));
  }
  test_membership_priority_identity_and_capacity() {
    /* Real caller ancestry and selected hc capacity are required before persistence. */
    var data = {
      mode: "detect",
      env: {
        HC_TERMINAL_ID: "t7"
      },
      ancestors: [123],
      capabilities: {
        hc: {
          supported: true,
          evidence: "fixture capacity"
        }
      }
    };
    var result = this.call({
      ...data
    });
    this.assertTrue(result.ok, result);
    this.assertEqual(result.result.execution_driver, "hc");
    for (var patch of [{
      ancestors: []
    }, {
      env: {
        HC_TERMINAL_ID: "elsewhere/t7"
      }
    }, {
      capabilities: {
        hc: {
          supported: false,
          blocker: "no host capacity"
        }
      }
    }]) {
      this.assertFalse(this.call({
        ...{
          ...data,
          ...patch
        }
      }).ok);
    }
    this.commands["hc send --help"] = "incompatible";
    this.assertFalse(this.call({
      ...data
    }).ok);
  }
  test_installation_and_hidden_context() {
    /* An installed binary or session routing variable alone is not membership. */
    var data = {
      mode: "detect",
      env: {
        HC_SESSION: "test"
      },
      ancestors: [],
      capabilities: {
        native: {
          supported: true,
          evidence: "native fixture"
        }
      }
    };
    this.assertEqual(this.call({
      ...data
    }).result.execution_driver, "native");
    this.assertFalse(this.call({
      ...data,
      "expected": "hc"
    }).ok);
  }
  test_launch_delivery_and_duplicate_prevention() {
    /* Compact launches persist returned IDs before requiring receipt acknowledgment. */
    var command = "hc run --json --bg --name bork-test --cwd " + String(this.root) + " --label bork-run=run-1 /bin/cat";
    this.commands[command] = json({
      address: "t7",
      first_message: {
        sent: false
      }
    });
    var result = this.call({
      "mode": "action",
      "action": "launch",
      "input": this.input
    });
    this.assertTrue(result.ok, result);
    var saved = JSON.parse(this.record.readText());
    this.assertEqual(saved.state, "delivery_requires_reconciliation");
    this.assertEqual(saved.created_ms, 1234);
    this.assertFalse(this.call({
      "mode": "action",
      "action": "launch",
      "input": this.input
    }).ok);
    var ack = P(this.root).join("ack.json");
    ack.writeText(json({
      run_id: "run-1",
      terminal_id: "t7",
      task_id: "wrong"
    }));
    this.assertFalse(this.call({
      "mode": "action",
      "action": "acknowledge",
      "input": {
        ...this.input,
        acknowledgment: String(ack)
      }
    }).ok);
  }
  test_codex_requires_no_daemon_and_launch_failure_retains_intent() {
    /* Template expansion cannot bypass Codex containment or erase uncertain launches. */
    var executable = P(this.root).join("codex");
    executable.writeText("#!/bin/sh\nexit 0\n");
    executable.chmod(448);
    this.job.writeText(json({
      argv: [String(executable), "task"],
      exit_record: String(P(this.root).join("exit.json"))
    }));
    this.assertFalse(this.call({
      "mode": "action",
      "action": "launch",
      "input": this.input
    }).ok);
    this.assertFalse(this.record.exists());
    this.job.writeText(json({
      argv: [String(executable), "--no-daemon", "-p", "profile", "task"],
      exit_record: String(P(this.root).join("exit.json"))
    }));
    this.assertFalse(this.call({
      "mode": "action",
      "action": "launch",
      "input": this.input
    }).ok);
    this.assertEqual(JSON.parse(this.record.readText()).state, "launch_uncertain");
  }
  test_interactive_arguments_and_noninteractive_modes() {
    /* Option operands and prompts do not become provider subcommands. */
    var executable = P(this.root).join("codex");
    executable.writeText("#!/bin/sh\nexit 0\n");
    executable.chmod(448);
    for (var args of [["--no-daemon", "-p", "review", "task"], ["--no-daemon", "--model", "exec", "task"], ["--no-daemon", "--", "review"], ["task", "--no-daemon"]]) {
      this.job.writeText(json({
        argv: [String(executable), ...args],
        exit_record: String(P(this.root).join("exit.json"))
      }));
      var command = "hc run --json --bg --name bork-test --cwd " + String(this.root) + " --label bork-run=run-1 " + join(" ", [String(executable), ...args]);
      this.commands[command] = json({
        address: "t7",
        first_message: {
          sent: true
        }
      });
      this.assertTrue(this.call({
        "mode": "action",
        "action": "launch",
        "input": this.input
      }).ok);
      this.record.unlink();
    }
    for (var args of [["--no-daemon", "review"], ["--no-daemon", "exec", "task"], ["--no-daemon", "e", "task"], ["--no-daemon", "app-server"], ["--no-daemon", "exec-server"], ["--no-daemon", "--print"], ["-p", "--no-daemon", "task"]]) {
      this.job.writeText(json({
        argv: [String(executable), ...args],
        exit_record: String(P(this.root).join("exit.json"))
      }));
      this.assertFalse(this.call({
        "mode": "action",
        "action": "launch",
        "input": this.input
      }).ok);
      this.assertFalse(this.record.exists());
    }
  }
  test_claude_print_after_option_operand_is_rejected() {
    /* Print flags remain noninteractive after documented Claude options. */
    var executable = P(this.root).join("claude");
    executable.writeText("#!/bin/sh\nexit 0\n");
    executable.chmod(448);
    for (var flag of ["--print", "-p"]) {
      this.job.writeText(json({
        argv: [String(executable), "--model", "sonnet", flag, "task"],
        exit_record: String(P(this.root).join("exit.json"))
      }));
      this.assertFalse(this.call({
        "mode": "action",
        "action": "launch",
        "input": this.input
      }).ok);
      this.assertFalse(this.record.exists());
    }
  }
  test_attention_navigation_retains_session() {
    /* Navigation identifies the recorded core session even in another shell. */
    this.saved({
      "session": "review's session"
    });
    this.terminal.status.state = "blocked";
    this.commands["hc get t7"] = json(this.terminal);
    this.commands["hc read t7 --lines 120"] = "Permission required";
    var result = this.call({
      "mode": "action",
      "action": "inspect",
      "input": this.input
    });
    this.assertIsNone(result.result.navigation);
    this.assertEqual(result.result.navigation_environment, {
      HC_SESSION: "review's session"
    });
    this.assertEqual(result.result.navigation_argv, ["hc", "attach", "t7"]);
  }
  test_uncertain_launch_reconciles_without_relaunch() {
    /* Only one run-labeled terminal on the original core can recover an address. */
    this.saved({
      "state": "launch_uncertain"
    });
    this.commands["hc ls --all"] = json({
      terminals: [{
        address: "t7",
        name: "bork-test"
      }]
    });
    this.assertTrue(this.call({
      "mode": "action",
      "action": "reconcile",
      "input": this.input
    }).ok);
    this.terminal.created_ms = 4321;
    this.commands["hc get t7"] = json(this.terminal);
    this.assertFalse(this.call({
      "mode": "action",
      "action": "reconcile",
      "input": this.input
    }).ok);
    this.terminal.labels = {
      "bork-run": "another-run"
    };
    this.commands["hc get t7"] = json(this.terminal);
    this.assertFalse(this.call({
      "mode": "action",
      "action": "reconcile",
      "input": this.input
    }).ok);
  }
  test_attention_uncertain_send_and_no_status_success() {
    /* Blocked prompts never receive input and statuses cannot report completed work. */
    this.saved({
      "state": "send_uncertain"
    });
    this.assertFalse(this.call({
      "mode": "action",
      "action": "send",
      "input": {
        ...this.input,
        task: "retry"
      }
    }).ok);
    this.terminal.status.state = "blocked";
    this.commands["hc get t7"] = json(this.terminal);
    this.commands["hc read t7 --lines 120"] = "Permission required: approve this action?";
    var result = this.call({
      "mode": "action",
      "action": "inspect",
      "input": this.input
    });
    this.assertEqual(result.result.observation, "attention");
    this.assertIn("Permission required", result.result.prompt_output);
    this.assertEqual(result.result.navigation, "hc attach t7");
    this.assertFalse(this.call({
      "mode": "action",
      "action": "send",
      "input": {
        ...this.input,
        task: "yes"
      }
    }).ok);
    this.terminal.status.state = "done";
    this.commands["hc get t7"] = json(this.terminal);
    this.assertEqual(this.call({
      "mode": "action",
      "action": "inspect",
      "input": this.input
    }).result.observation, "requires_result_and_ack");
  }
  test_cleanup_requires_result_descendants_and_exact_ownership() {
    /* Only a verified finished owned terminal may be removed after output capture. */
    this.saved();
    this.assertFalse(this.call({
      "mode": "action",
      "action": "cleanup",
      "input": this.input
    }).ok);
    this.terminal.state = "finished";
    this.commands["hc get t7"] = json(this.terminal);
    this.commands["hc read t7 --lines 120"] = "retained output";
    this.commands["hc rm t7"] = json({
      removed: "t7"
    });
    var request = {
      ...this.input,
      results_verified: true,
      descendants_stopped: true
    };
    this.assertEqual(this.call({
      "mode": "action",
      "action": "cleanup",
      "input": request
    }).result.state, "removed");
    this.commands["hc server status"] = json({
      core: {
        id: "replacement"
      }
    });
    this.assertFalse(this.call({
      "mode": "action",
      "action": "cleanup",
      "input": request
    }).ok);
  }
}
if (require.main === module) suite(HcTests, {});
module.exports = {
  HcTests
};
