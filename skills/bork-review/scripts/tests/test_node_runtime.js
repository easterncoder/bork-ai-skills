'use strict';

const {
  os,
  P,
  Fixture,
  suite,
  run,
  background,
  temporary,
  which,
  sleep,
  range,
  enumerate,
  json,
  sha256,
  copyTree,
  signal
} = require('../../../../tests/support.js');
/* Migration-sensitive filesystem, process and advisory-lock behavior checks. */
var NODE = process.execPath;
var SUPPORT = P(P(__filename).resolve().parents[1]).join("support.js");
var RUNNER = P(SUPPORT.parents[2]).join("bork-doitall/scripts/tmux.js");
class NodeRuntimeTests extends Fixture {
  /* Use independent local files and processes without contacting any service. */
  run_node(code, ...args) {
    /* Run a Node fixture from an unrelated working directory. */
    return run([NODE, "-e", code, String(SUPPORT), ...args.map(String)], {
      "cwd": os.tmpdir(),
      "text": true,
      "capture_output": true,
      "timeout": 10
    });
  }
  test_screen_topology_preserves_newline_splits_and_flat_leaf_ids() {
    /* Replay real Screen dumps with source-compatible replacement semantics. */
    var result = this.run_node("const c=require(process.argv[1]);\nconst s=require(require('node:path').resolve(require('node:path').dirname(process.argv[1]), '../../bork-doitall/scripts/layout-adapters/screen.js'));\nprocess.stdout.write(c.json_encode(s.borkLayoutScreenTopology('split\\nfocus\\nsplit -v\\nfocus\\nfocus')));\n");
    this.assertEqual(result.status, 0, result.stderr);
    var topology = JSON.parse(result.stdout);
    this.assertEqual(topology.leaves, [0, 1, 3]);
    this.assertEqual(topology.nodes[4].children, [1, 3]);
  }
  test_atomic_failure_retains_destination_and_cleans_temporary() {
    /* Rename and serialization failures must leave the prior record intact. */
    var _temp40 = temporary({
      "prefix": "node atomic "
    });
    try {
      var directory = _temp40.name;
      var root = P(directory);
      var target = P(root).join("record.json");
      target.writeText("{\"old\":true}");
      var link = P(root).join("link.json");
      link.symlinkTo(target);
      var blocked = P(root).join("directory");
      blocked.mkdir();
      var result = this.run_node("const c=require(process.argv[1]);\nfor(const target of process.argv.slice(2)){try{c.atomicWrite(target,'changed');process.exitCode=1;}catch{}}\nconst cyclic={};cyclic.self=cyclic;\ntry{c.atomicWrite(process.argv[2],c.json_encode(cyclic));process.exitCode=1;}catch{}\n", link, blocked);
      this.assertEqual(result.status, 0, result.stderr);
      this.assertEqual(target.readText(), "{\"old\":true}");
      this.assertEqual(root.iterdir().map(p => p.name).sort(), ["directory", "link.json", "record.json"]);
    } finally {
      _temp40.cleanup();
    }
  }
  test_runner_retains_spawn_failure_and_signal() {
    /* A failed spawn and signal exit cannot become successful process evidence. */
    var _temp59 = temporary({});
    try {
      var directory = _temp59.name;
      var root = P(directory);
      var broken = P(root).join("broken");
      broken.writeText("#!/missing-owned-test-interpreter\n");
      broken.chmod(448);
      for (var [index, argv] of enumerate([[String(broken)], [NODE, "-e", "process.kill(process.pid,\"SIGTERM\")"]])) {
        var record = P(root).join("exit-" + String(index) + ".json");
        var job = P(root).join("job-" + String(index) + ".json");
        job.writeText(json({
          argv: argv,
          exit_record: String(record)
        }));
        var launch = P(root).join("launch-" + String(index) + ".json");
        launch.writeText(json({
          job: String(job),
          cwd: String(root)
        }));
        var result = run([NODE, String(RUNNER), "run", String(launch)], {
          "text": true,
          "capture_output": true,
          "timeout": 10
        });
        var evidence = JSON.parse(record.readText());
        this.assertNotEqual(result.status, 0);
        this.assertNotEqual(evidence.exit_code, 0);
        this.assertIn(index === 0 ? "spawn_error" : "signal", evidence);
      }
    } finally {
      _temp59.cleanup();
    }
  }
  test_kernel_lock_contention_and_crash_release() {
    /* A killed lock owner releases its inode without deleting or replacing it. */
    var _temp80 = temporary({});
    try {
      var directory = _temp80.name;
      var root = P(directory);
      var lock = P(root).join("record.lock");
      var ready = P(root).join("ready");
      var holder = background(["flock", "--exclusive", String(lock), NODE, "-e", "require(\"node:fs\").writeFileSync(process.argv[1],\"ready\");setTimeout(()=>{},30000)", String(ready)], {
        "start_new_session": true,
        "stdout": null,
        "stderr": null
      });
      try {
        for (var _ of range(100)) {
          if (ready.exists()) {
            break;
          }
          sleep(0.02);
        }
        this.assertTrue(ready.exists());
        var attempt = run(["flock", "--nonblock", String(lock), NODE, "-e", ""], {
          "timeout": 5
        });
        this.assertNotEqual(attempt.status, 0);
        process.kill(-holder.pid, signal.SIGKILL);
        holder.wait({
          "timeout": 5
        });
        for (var _ of range(100)) {
          attempt = run(["flock", "--nonblock", String(lock), NODE, "-e", ""], {
            "timeout": 5
          });
          if (attempt.status === 0) {
            break;
          }
          sleep(0.02);
        }
        this.assertEqual(attempt.status, 0);
        this.assertTrue(lock.exists());
      } finally {
        if (holder.poll() === null) {
          process.kill(-holder.pid, signal.SIGKILL);
          holder.wait({
            "timeout": 5
          });
        }
        holder.stderr.close();
      }
    } finally {
      _temp80.cleanup();
    }
  }
  test_standalone_and_plugin_modules_ignore_callers_module_type() {
    /* Installed sibling scripts load from arbitrary directories in ES module projects. */
    var _temp112 = temporary({
      "prefix": "node installed "
    });
    try {
      var directory = _temp112.name;
      var root = P(directory);
      P(root).join("package.json").writeText("{\"type\":\"module\"}");
      var skills = SUPPORT.parents[2];
      for (var name of ["bork-review", "bork-doitall"]) {
        copyTree(P(P(skills).join(name)).join("scripts"), P(P(P(root).join("skills")).join(name)).join("scripts"), {
          "ignore": ["tests", "__pycache__", "*.php"]
        });
      }
      for (var install of [P(root).join("skills"), P(P(root).join("plugin")).join("skills")]) {
        if (!(String(install) === String(P(root).join("skills")))) {
          copyTree(P(root).join("skills"), install, {});
        }
        var output = P(root).join("output-" + install.parent.name + ".json");
        var payload = {
          action: "write",
          path: String(output),
          data: {
            installed: true
          }
        };
        var result = run([NODE, String(P(install).join("bork-review/scripts/workflow.js"))], {
          "input": json(payload),
          "cwd": os.tmpdir(),
          "capture_output": true,
          "text": true,
          "timeout": 10
        });
        this.assertEqual(result.status, 0, result.stderr + result.stdout);
        this.assertEqual(JSON.parse(output.readText()), {
          installed: true
        });
      }
    } finally {
      _temp112.cleanup();
    }
  }
  test_integer_fields_reject_fractional_tokens_and_unsafe_values() {
    /* Decimal/exponent tokens cannot pass strict integer schema validation. */
    var result = this.run_node("const c=require(process.argv[1]);\nconst numbers=c.json_decode('[1,1.0,1e0,1.5]');\nif(!c.is_int(numbers[0])||numbers.slice(1).some(c.is_int))process.exit(1);\ntry{c.json_decode('9007199254740993');process.exit(1);}catch{}\nprocess.stdout.write(c.json_encode(numbers));");
    this.assertEqual(result.status, 0, result.stderr);
    this.assertEqual(JSON.parse(result.stdout), [1, 1, 1, 1.5]);
  }
  test_non_ascii_evidence_hash_preserves_existing_serialization() {
    /* Unicode and URLs keep the existing deterministic evidence fingerprint. */
    var data = {
      url: "https://example.test/path",
      body: "caf\u00e9 \ud83d\ude00"
    };
    var expected = sha256(Buffer.from(String(json(data, {
      "sort_keys": true,
      "ensure_ascii": true,
      "separators": [",", ":"]
    }))));
    var result = this.run_node("const e=require(require(\"node:path\").join(require(\"node:path\").dirname(process.argv[1]),\"evidence.js\"));process.stdout.write(e.evidenceHash(JSON.parse(process.argv[2])));", json(data));
    this.assertEqual(result.status, 0, result.stderr);
    this.assertEqual(result.stdout, expected);
  }
  test_named_keys_and_empty_lists_keep_their_record_shapes() {
    /* Numeric IDs, false-like values and prototype names remain ordinary data. */
    var result = this.run_node("const c=require(process.argv[1]);\nconst data=c.json_decode('{\"entries\":{\"12\":{\"body\":\"value\"}},\"empty\":[],\"__proto__\":{\"owned\":true}}');\nif(c.get({},'toString')!==undefined||c.truth('0')||c.truth([]))process.exit(1);\nprocess.stdout.write(c.json_encode(data));");
    this.assertEqual(result.status, 0, result.stderr);
    this.assertEqual(JSON.parse(result.stdout), {
      entries: {
        "12": {
          body: "value"
        }
      },
      empty: [],
      ["__proto__"]: {
        owned: true
      }
    });
  }
}
if (require.main === module) suite(NodeRuntimeTests, {
  "test_kernel_lock_contention_and_crash_release": !which("flock") ? "util-linux flock is required" : false
});
module.exports = {
  NodeRuntimeTests
};
