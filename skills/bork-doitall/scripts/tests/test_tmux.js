'use strict';

const {
  P,
  Fixture,
  suite,
  run,
  checkOutput,
  temporary,
  which,
  sleep,
  range,
  json
} = require('../../../../tests/support.js');
/* Isolated scheduler and real tmux tests; never run an AI CLI or contact GitHub. */
var HELPER = P(P(__filename).resolve().parents[1]).join("tmux.js");
class DoitallTests extends Fixture {
  /* Exercise public JSON commands against disposable tmux sessions. */
  setUp() {
    /* Prepare a private socket and temporary input directory. */
    this.temp = temporary({
      "prefix": "doitall-test-"
    });
    this.root = P(this.temp.name);
    this.socket = this.root.name;
    this.counter = 0;
  }
  tearDown() {
    /* Stop only this test's isolated server and remove its files. */
    run(["tmux", "-L", this.socket, "kill-server"], {
      "capture_output": true
    });
    this.temp.cleanup();
  }
  invoke(action, data) {
    /* Invoke a helper command with an immutable JSON input file. */
    this.counter += 1;
    var source = P(this.root).join("input-" + String(this.counter) + ".json");
    source.writeText(json(data));
    var result = run([process.execPath, String(HELPER), action, String(source)], {
      "capture_output": true,
      "text": true,
      "timeout": 15
    });
    var output = JSON.parse(result.stdout);
    this.assertEqual(result.status, output.ok ? 0 : 1, result.stderr);
    return output;
  }
  target({
    status = "queued",
    parents = []
  } = {}) {
    /* Construct a normalized scheduling target. */
    return {
      status: status,
      depends_on: Array.from(parents)
    };
  }
  test_limit_includes_review_wait() {
    /* Two active targets allow one launch; three allow none. */
    var targets = {
      a: this.target({
        "status": "waiting_review"
      }),
      b: this.target({
        "status": "running"
      }),
      c: this.target()
    };
    this.assertEqual(this.invoke("schedule", {
      targets: targets,
      max_concurrency: 3
    }).result.launch, ["c"]);
    targets.c.status = "starting";
    this.assertEqual(this.invoke("schedule", {
      targets: targets,
      max_concurrency: 3
    }).result.launch, []);
  }
  test_serial_default() {
    /* Default scheduling finishes one target before selecting the next. */
    var targets = {
      a: this.target(),
      b: this.target()
    };
    this.assertEqual(this.invoke("schedule", {
      targets: targets
    }).result.launch, ["a"]);
    for (var status of ["starting", "running", "waiting_review"]) {
      targets.a.status = status;
      this.assertEqual(this.invoke("schedule", {
        targets: targets
      }).result.launch, []);
    }
    targets.a.status = "complete";
    this.assertEqual(this.invoke("schedule", {
      targets: targets
    }).result.launch, ["b"]);
  }
  test_explicit_limit_and_reduction() {
    /* Explicit parallelism respects capacity and lets active work drain. */
    var targets = {
      a: this.target(),
      b: this.target(),
      c: this.target()
    };
    this.assertEqual(this.invoke("schedule", {
      targets: targets,
      max_concurrency: 2
    }).result.launch, ["a", "b"]);
    targets.a.status = "running";
    targets.b.status = "waiting_review";
    this.assertEqual(this.invoke("schedule", {
      targets: targets,
      max_concurrency: 1
    }).result.launch, []);
  }
  test_invalid_concurrency() {
    /* Reject unsupported concurrency values. */
    for (var limit of [0, 4, -1, "2", true, 1.5]) {
      this.assertFalse(this.invoke("schedule", {
        targets: {},
        max_concurrency: limit
      }).ok);
    }
  }
  test_dependency_requires_complete() {
    /* Blocked or merely running parents never release a child. */
    var targets = {
      parent: this.target({
        "status": "blocked"
      }),
      child: this.target({
        "parents": ["parent"]
      }),
      other: this.target()
    };
    var blocked = this.invoke("schedule", {
      targets: targets
    }).result;
    this.assertEqual(blocked.launch, ["other"]);
    this.assertEqual(blocked.blocked, {
      child: {
        reason: "dependency_blocked",
        dependency: "parent"
      }
    });
    targets.parent.status = "complete";
    this.assertEqual(this.invoke("schedule", {
      targets: targets
    }).result.launch, ["child"]);
  }
  test_transitive_block_and_cycle() {
    /* Report cycle members and downstream targets while independent work proceeds. */
    var targets = {
      a: this.target({
        "parents": ["b"]
      }),
      b: this.target({
        "parents": ["a"]
      }),
      downstream: this.target({
        "parents": ["a"]
      }),
      skipped: this.target({
        "status": "skipped"
      }),
      blocked_by_skip: this.target({
        "parents": ["skipped"]
      }),
      independent: this.target()
    };
    var result = this.invoke("schedule", {
      targets: targets
    }).result;
    this.assertEqual(result.launch, ["independent"]);
    this.assertEqual(result.waiting, []);
    this.assertEqual(result.blocked.a.reason, "dependency_cycle");
    this.assertEqual(result.blocked.b.reason, "dependency_cycle");
    this.assertEqual(new Set(result.blocked.a.cycle), new Set(["a", "b"]));
    this.assertEqual(result.blocked.downstream, {
      reason: "dependency_blocked",
      dependency: "a"
    });
    this.assertEqual(result.blocked.blocked_by_skip, {
      reason: "dependency_blocked",
      dependency: "skipped"
    });
  }
  test_waiting_on_active_parent_is_not_blocked() {
    /* An active prerequisite remains a legitimate wait. */
    var targets = {
      parent: this.target({
        "status": "running"
      }),
      child: this.target({
        "parents": ["parent"]
      })
    };
    var result = this.invoke("schedule", {
      targets: targets
    }).result;
    this.assertEqual(result.waiting, ["child"]);
    this.assertEqual(result.blocked, {});
  }
  test_unknown_dependency_rejected() {
    /* Malformed plans cannot silently ignore prerequisites. */
    this.assertFalse(this.invoke("schedule", {
      targets: {
        x: this.target({
          "parents": ["missing"]
        })
      }
    }).ok);
  }
  test_discovered_targets_can_expand_batch() {
    /* A target queue may exceed three entries while concurrency stays capped. */
    var targets = Object.fromEntries(range(7).map(i => [String(i), this.target()]));
    var result = this.invoke("schedule", {
      targets: targets,
      max_concurrency: 3
    });
    this.assertTrue(result.ok);
    this.assertEqual(result.result.launch, ["0", "1", "2"]);
    this.assertEqual(result.result.waiting, ["3", "4", "5", "6"]);
  }
  launch({
    role = "master",
    session = "doitall-fixture",
    socket_path = null
  } = {}) {
    /* Launch a harmless Node.js process in place of a master AI. */
    var suffix = String(this.counter + 1);
    var record = P(this.root).join("exit-" + String(suffix) + ".json");
    var job = P(this.root).join("job-" + String(suffix) + ".json");
    job.writeText(json({
      argv: [process.execPath, "-e", "console.log(\"visible fixture\");"],
      exit_record: String(record)
    }));
    var data = {
      role: role,
      cwd: String(this.root),
      job: String(job),
      socket: this.socket
    };
    if (socket_path !== null) {
      delete data.socket;
      data.socket_path = socket_path;
    }
    data.session_name = session;
    return [this.invoke("launch", data), record];
  }
  test_absolute_socket_preserves_selected_server() {
    /* Launch on the inherited absolute socket rather than a default server. */
    var socket = String(P(this.root).join("selected.sock"));
    try {
      var [result, _] = this.launch({
        "socket_path": socket
      });
      this.assertTrue(result.ok, result);
      var role = checkOutput(["tmux", "-S", socket, "display-message", "-p", "-t", result.result.pane, "#{@bork-role}"], {
        "text": true
      }).trim();
      this.assertEqual(role, "master");
    } finally {
      run(["tmux", "-S", socket, "kill-server"], {
        "capture_output": true
      });
    }
  }
  test_unmanaged_roles_rejected() {
    /* Only target masters and coordinated workers receive sessions. */
    for (var role of ["prify", "goodcode", "unknown"]) {
      var [result, _] = this.launch({
        "role": role
      });
      this.assertFalse(result.ok);
      this.assertIn("Only master, review or fix sessions", result.error);
    }
  }
  test_goodcode_workers_have_separate_sessions() {
    /* Review and fix can run concurrently under their own role identities. */
    for (var role of ["review", "fix"]) {
      var [result, _] = this.launch({
        "role": role,
        "session": "fixture-" + String(role)
      });
      this.assertTrue(result.ok, result);
      var actual = checkOutput(["tmux", "-L", this.socket, "display-message", "-p", "-t", result.result.pane, "#{@bork-role}"], {
        "text": true
      }).trim();
      this.assertEqual(actual, role);
    }
  }
  test_separate_master_sessions() {
    /* Independent targets get independent single-pane sessions. */
    var [first, _] = this.launch({
      "session": "doitall-fixture"
    });
    var [second, _] = this.launch({
      "session": "doitall-second"
    });
    this.assertTrue(first.ok, first);
    this.assertTrue(second.ok, second);
    this.assertNotEqual(first.result.pane, second.result.pane);
    for (var session of ["doitall-fixture", "doitall-second"]) {
      var lines = checkOutput(["tmux", "-L", this.socket, "list-panes", "-t", session, "-F", "#{@bork-role} #{pane_left}"], {
        "text": true
      }).trimEnd().split(/\r?\n/);
      this.assertEqual(lines, ["master 0"]);
    }
  }
  test_master_retains_output_and_result() {
    /* The master stays inspectable with separate process evidence. */
    var [result, master_record] = this.launch();
    this.assertTrue(result.ok, result);
    var master = result.result.pane;
    var deadline = Date.now() / 1000 + 5;
    while (!master_record.exists() && Date.now() / 1000 < deadline) {
      sleep(0.05);
    }
    this.assertEqual(JSON.parse(master_record.readText()).exit_code, 0);
    var lines = checkOutput(["tmux", "-L", this.socket, "list-panes", "-t", "doitall-fixture", "-F", "#{@bork-role}:#{pane_dead}"], {
      "text": true
    }).trimEnd().split(/\r?\n/);
    this.assertEqual(lines, ["master:1"]);
    var output = checkOutput(["tmux", "-L", this.socket, "capture-pane", "-p", "-S", "-1000", "-t", master], {
      "text": true
    });
    this.assertIn("visible fixture", output);
  }
}
if (require.main === module) suite(DoitallTests, {
  "test_absolute_socket_preserves_selected_server": !which("tmux") ? "tmux unavailable" : false,
  "test_goodcode_workers_have_separate_sessions": !which("tmux") ? "tmux unavailable" : false,
  "test_separate_master_sessions": !which("tmux") ? "tmux unavailable" : false,
  "test_master_retains_output_and_result": !which("tmux") ? "tmux unavailable" : false
});
module.exports = {
  DoitallTests
};
