'use strict';

const {
  P,
  Fixture,
  suite,
  run,
  temporary,
  which,
  enumerate,
  json
} = require('../../../../tests/support.js');
/* Verify the terminal runner shared by Herdr and tmux without either server. */
var HELPER = P(P(__filename).resolve().parents[1]).join("tmux.js");
class TerminalRunnerTests extends Fixture {
  /* Exercise process evidence independently of multiplexer availability. */
  test_shell_commands_preserve_paths_and_do_not_execute_path_content() {
    /* Run generated commands through available destination shells. */
    var shells = [["posix", which("sh"), ["-c"]], ["powershell", which("pwsh") || which("powershell"), ["-NoProfile", "-Command"]], ["cmd", which("cmd.exe"), ["/d", "/s", "/c"]]];
    var node = process.execPath;
    for (var [shell, executable, flags] of shells) {
      if (!executable) {
        continue;
      }
      var _temp29 = temporary({});
      try {
        var directory = _temp29.name;
        var root = P(directory);
        var name = !(shell === "cmd") ? "space ' & $() `touch injected` ! %" : "space & (literal)";
        var nested = P(root).join(name);
        nested.mkdir();
        var record = P(nested).join("exit.json");
        var job = P(nested).join("job.json");
        job.writeText(json({
          argv: [node, "-e", "process.stdout.write(\"runner output\");"],
          exit_record: String(record)
        }));
        var launch = P(nested).join("launch.json");
        launch.writeText(json({
          shell: shell,
          cwd: String(root),
          job: String(job)
        }));
        var built = run([node, String(HELPER), "command", String(launch)], {
          "capture_output": true,
          "text": true,
          "timeout": 10,
          "check": true
        });
        var command = JSON.parse(built.stdout).result.command;
        var result = run([executable, ...flags, command], {
          "cwd": root,
          "capture_output": true,
          "text": true,
          "timeout": 10
        });
        this.assertEqual(result.status, 0, result.stderr);
        this.assertIn("runner output", result.stdout);
        this.assertEqual(JSON.parse(record.readText()).exit_code, 0);
        this.assertFalse(P(root).join("injected").exists());
      } finally {
        _temp29.cleanup();
      }
    }
  }
  test_unsafe_cmd_expansion_is_rejected_before_submission() {
    /* Cmd cannot safely preserve percent expansion in the launch path. */
    var _temp58 = temporary({});
    try {
      var directory = _temp58.name;
      var source = P(P(directory)).join("%PATH%.json");
      source.writeText(json({
        shell: "cmd"
      }));
      var result = run([process.execPath, String(HELPER), "command", String(source)], {
        "capture_output": true,
        "text": true,
        "timeout": 10
      });
      this.assertEqual(result.status, 1);
      this.assertFalse(JSON.parse(result.stdout).ok);
    } finally {
      _temp58.cleanup();
    }
  }
  test_codex_launch_requires_a_real_global_no_daemon_flag() {
    /* Reject text and option operands before any provider can execute. */
    var _temp70 = temporary({});
    try {
      var directory = _temp70.name;
      var root = P(directory);
      var executable = P(root).join("codex");
      executable.writeText("#!/bin/sh\ntouch \"" + String(P(root).join("ran")) + "\"\n");
      executable.chmod(448);
      var rejected = [[], ["task --no-daemon"], ["-m", "--no-daemon"], ["--config", "--no-daemon"], ["--", "--no-daemon"], ["exec", "task --no-daemon"], ["--profile=--no-daemon"]];
      var accepted = [["--no-daemon", "task"], ["task", "--no-daemon"], ["--no-daemon", "exec", "task"], ["-m", "gpt-6.1-sol", "--no-daemon", "task"]];
      for (var [index, args] of enumerate(rejected.concat(accepted))) {
        var job = P(root).join("job-" + String(index) + ".json");
        var record = P(root).join("exit-" + String(index) + ".json");
        job.writeText(json({
          argv: [String(executable), ...args],
          exit_record: String(record)
        }));
        var launch = P(root).join("launch-" + String(index) + ".json");
        launch.writeText(json({
          cwd: directory,
          job: String(job)
        }));
        var result = run([process.execPath, String(HELPER), "run", String(launch)], {
          "capture_output": true,
          "text": true,
          "timeout": 10
        });
        if (rejected.includes(args)) {
          this.assertEqual(result.status, 1, result.stdout);
          this.assertIn("--no-daemon", JSON.parse(result.stdout).error);
          this.assertFalse(P(root).join("ran").exists());
          this.assertFalse(record.exists());
          launch.writeText(json({
            cwd: directory,
            job: String(job),
            shell: "posix",
            layout_record: String(P(root).join("absent-layout.json"))
          }));
          var rejected_launch = run([process.execPath, String(HELPER.withName("herdr.js")), "launch", String(launch)], {
            "capture_output": true,
            "text": true,
            "timeout": 10
          });
          this.assertEqual(rejected_launch.status, 1);
          this.assertIn("--no-daemon", JSON.parse(rejected_launch.stdout).error);
          this.assertFalse(P(root).join("absent-layout.json").exists());
        } else {
          this.assertEqual(result.status, 0, result.stdout);
          this.assertTrue(P(root).join("ran").exists());
          P(root).join("ran").unlink();
        }
      }
    } finally {
      _temp70.cleanup();
    }
  }
  test_runner_preserves_exit_and_output_without_tmux() {
    /* Successful and failed commands publish their actual exit code. */
    var node = process.execPath;
    for (var code of [0, 7]) {
      var _temp112 = temporary({});
      try {
        var directory = _temp112.name;
        var root = P(directory);
        var record = P(root).join("exit.json");
        var job = P(root).join("job.json");
        job.writeText(json({
          argv: [node, "-e", "process.stdout.write(process.cwd()); process.exit(" + String(code) + ");"],
          exit_record: String(record)
        }));
        var launch = P(root).join("launch.json");
        launch.writeText(json({
          cwd: String(root),
          job: String(job),
          role: "master"
        }));
        var env = Object.assign({}, process.env, {
          "PATH": ""
        });
        var result = run([node, String(HELPER), "run", String(launch)], {
          "capture_output": true,
          "text": true,
          "env": env,
          "timeout": 10
        });
        this.assertEqual(result.status, code, result.stderr);
        this.assertEqual(result.stdout, String(root));
        var evidence = JSON.parse(record.readText());
        this.assertEqual(evidence.exit_code, code);
        var retry = run([node, String(HELPER), "run", String(launch)], {
          "capture_output": true,
          "text": true,
          "env": env,
          "timeout": 10
        });
        this.assertEqual(retry.status, 1);
        this.assertFalse(JSON.parse(retry.stdout).ok);
        this.assertEqual(JSON.parse(record.readText()), evidence);
      } finally {
        _temp112.cleanup();
      }
    }
  }
}
if (require.main === module) suite(TerminalRunnerTests, {});
module.exports = {
  TerminalRunnerTests
};
