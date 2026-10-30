'use strict';

const {
  P,
  Fixture,
  suite,
  run,
  checkOutput,
  temporary,
  which,
  json,
  takeOptions
} = require('../../../../tests/support.js');
/* Run isolated CLI behavior checks with Node.js and Git; no network access. */
var HELPER = P(P(__filename).resolve().parents[1]).join("workflow.js");
class WorkflowTests extends Fixture {
  /* Verify observable helper behavior in disposable repositories. */
  setUp() {
    /* Create an isolated repository and suppress external Git configuration. */
    this.temp = temporary({
      "prefix": "bork-runtime-test-"
    });
    this.root = P(this.temp.name);
    this.repo = P(this.root).join("repo");
    this.empty_config = P(this.root).join("gitconfig");
    this.empty_config.writeText("");
    this.env = Object.assign({}, process.env, {
      "GIT_CONFIG_NOSYSTEM": "1",
      "GIT_CONFIG_GLOBAL": String(this.empty_config)
    });
    this.git("init", "-b", "main", String(this.repo), {
      "cwd": this.root
    });
    this.git("config", "user.name", "Fixture");
    this.git("config", "user.email", "developer@example.test");
    this.git("config", "commit.gpgsign", "false");
    P(this.repo).join("source.txt").writeText("initial\n");
    this.git("add", ".");
    this.git("commit", "-m", "test: fixture");
    this.head = this.git("rev-parse", "HEAD").trim();
  }
  tearDown() {
    /* Remove the disposable fixture. */
    this.temp.cleanup();
  }
  git(...args) {
    var {
      cwd = null
    } = takeOptions(args);
    /* Run Git without a shell in the isolated environment. */
    return checkOutput(["git", ...args], {
      "cwd": cwd || this.repo,
      "env": this.env,
      "stderr": null,
      "text": true
    });
  }
  call(action, fields = {}) {
    /* Invoke the public JSON interface and verify its exit status contract. */
    var result = run([process.execPath, String(HELPER)], {
      "input": json(Object.assign({}, {
        "action": action,
        ...fields
      })),
      "text": true,
      "capture_output": true,
      "env": this.env,
      "timeout": 10
    });
    var output = JSON.parse(result.stdout);
    this.assertEqual(result.status, output.ok ? 0 : 1, result.stderr);
    return output;
  }
  test_inspect_and_dirty_guard() {
    /* A changed HEAD blocks handoffs; dirty status blocks cleanup. */
    var state = this.call("inspect", {
      "repo": String(this.repo)
    }).result;
    this.assertEqual(state.head, this.head);
    this.assertTrue(state.clean_including_ignored);
    this.assertFalse(this.call("guard", {
      "repo": String(this.repo),
      "branch": "other",
      "head": this.head
    }).ok);
    P(this.repo).join("source.txt").writeText("dirty\n");
    this.assertEqual(this.call("cleanup-check", {
      "repo": String(this.repo),
      "branch": "main",
      "head": this.head
    }).result.event, "preserve");
  }
  test_ignored_content_prevents_cleanup() {
    /* Ignored files must be reported even when tracked files are clean. */
    var stream = P(this.repo).join(".git/info/exclude").open("a");
    try {
      stream.write("\nsecret.txt\n");
    } finally {
      stream.close();
    }
    P(this.repo).join("secret.txt").writeText("preserve me");
    var result = this.call("cleanup-check", {
      "repo": String(this.repo),
      "branch": "main",
      "head": this.head
    }).result;
    this.assertEqual(result.event, "preserve");
    this.assertTrue(result.entries.map(entry => entry.includes("secret.txt")).some(Boolean));
  }
  test_write_lock_and_delta() {
    /* Atomic publication, lock ownership and snapshot deltas retain evidence. */
    var lock = String(P(this.root).join("lock"));
    this.assertTrue(this.call("lock", {
      "path": lock,
      "token": "one"
    }).ok);
    this.assertFalse(this.call("lock", {
      "path": lock,
      "token": "two"
    }).ok);
    this.assertFalse(this.call("lock", {
      "path": lock,
      "token": "two",
      "operation": "release"
    }).ok);
    this.assertTrue(this.call("lock", {
      "path": lock,
      "token": "one",
      "operation": "release"
    }).ok);
    var [previous, current] = [P(this.root).join("before.json"), P(this.root).join("after.json")];
    this.call("write", {
      "path": String(previous),
      "data": {
        a: 1,
        b: 2
      }
    });
    this.call("write", {
      "path": String(current),
      "data": {
        a: 1,
        b: 3,
        c: 4
      }
    });
    var result = this.call("delta", {
      "previous": String(previous),
      "current": String(current)
    }).result;
    this.assertEqual(result.changed, {
      b: 3,
      c: 4
    });
    this.assertEqual(this.call("delta", {
      "previous": String(current),
      "current": String(current)
    }).result.event, "unchanged");
  }
  test_transition_ownership_and_stale_session() {
    /* The state machine refuses wrong roles, stale states and mismatched runs. */
    var session = P(this.root).join("session.json");
    session.writeText(json({
      run_id: "run",
      worktree: String(this.repo)
    }));
    var fields = Object.assign({}, {
      "repo": String(this.repo),
      "branch": "main",
      "head": this.head,
      "session": String(session),
      "run_id": "run"
    });
    this.assertTrue(this.call("transition", {
      ...fields,
      "role": "owner",
      ...{
        from: "missing",
        to: "coded"
      }
    }).ok);
    this.assertFalse(this.call("transition", {
      ...fields,
      "role": "fix",
      ...{
        from: "coded",
        to: "coding"
      }
    }).ok);
    this.assertTrue(this.call("transition", {
      ...fields,
      "role": "review",
      ...{
        from: "coded",
        to: "reviewing"
      }
    }).ok);
    this.assertFalse(this.call("transition", {
      ...fields,
      "role": "review",
      ...{
        from: "coded",
        to: "reviewing"
      }
    }).ok);
    fields.run_id = "wrong";
    this.assertFalse(this.call("transition", {
      ...fields,
      "role": "review",
      ...{
        from: "reviewing",
        to: "good"
      }
    }).ok);
    this.assertEqual(P(this.repo).join(".status").readText().trim(), "reviewing");
  }
  test_bounded_wait() {
    /* Missing, pending, invalid and terminal states have distinct outcomes. */
    var status = P(this.root).join("status");
    this.assertFalse(this.call("wait", {
      "path": String(status),
      "seconds": 0
    }).ok);
    this.assertEqual(this.call("wait", {
      "path": String(status),
      "seconds": 0,
      "allow_missing": true
    }).result.event, "waiting");
    status.writeText("coding\n");
    this.assertEqual(this.call("wait", {
      "path": String(status),
      "wanted": ["reviewed"],
      "seconds": 0
    }).result.event, "waiting");
    status.writeText("blocked\n");
    this.assertEqual(this.call("wait", {
      "path": String(status),
      "wanted": ["reviewed"],
      "seconds": 0
    }).result.event, "blocked");
    status.writeText("invalid\n");
    this.assertFalse(this.call("wait", {
      "path": String(status),
      "seconds": 0
    }).ok);
  }
  test_worktree_branch_collision() {
    /* Creation uses the chosen commit and does not overwrite an occupied branch. */
    var worktree = P(this.root).join("worktree with spaces");
    var result = this.call("worktree-create", {
      "repo": String(this.repo),
      "branch": "fix/123",
      "path": String(worktree),
      "base": this.head
    });
    this.assertTrue(result.ok);
    this.assertEqual(P(worktree).join("source.txt").readText(), "initial\n");
    this.assertFalse(this.call("worktree-create", {
      "repo": String(this.repo),
      "branch": "fix/123",
      "path": String(P(this.root).join("other")),
      "base": this.head
    }).ok);
    this.assertFalse(P(this.root).join("other").exists());
    this.git("worktree", "remove", String(worktree));
  }
  test_signed_commit_verified() {
    /* A locally trusted SSH-signed commit passes the real Git verifier. */
    var key = P(this.root).join("signing-key");
    run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", String(key)], {
      "check": true,
      "capture_output": true
    });
    var allowed = P(this.root).join("allowed-signers");
    allowed.writeText("developer@example.test " + P(String(key) + ".pub").readText());
    this.git("config", "gpg.format", "ssh");
    this.git("config", "user.signingkey", String(key));
    this.git("config", "gpg.ssh.allowedSignersFile", String(allowed));
    this.git("config", "commit.gpgsign", "true");
    P(this.repo).join("source.txt").writeText("signed change\n");
    this.git("add", ".");
    this.git("commit", "-m", "fix: signed fixture");
    var head = this.git("rev-parse", "HEAD").trim();
    var result = this.call("verify-commits", {
      "repo": String(this.repo),
      "base": this.head,
      "head": head
    });
    this.assertTrue(result.ok);
    this.assertEqual(result.result.commits, [head]);
    this.git("config", "user.email", "another@example.test");
    this.assertFalse(this.call("verify-commits", {
      "repo": String(this.repo),
      "base": this.head,
      "head": head
    }).ok);
    this.assertTrue(this.call("verify-commits", {
      "repo": String(this.repo),
      "base": this.head,
      "head": head,
      "email": "developer@example.test"
    }).ok);
  }
  test_unsigned_commit_rejected() {
    /* An unsigned new commit cannot pass signature validation. */
    P(this.repo).join("source.txt").writeText("new\n");
    this.git("add", ".");
    this.git("commit", "-m", "fix: fixture");
    var head = this.git("rev-parse", "HEAD").trim();
    this.assertFalse(this.call("verify-commits", {
      "repo": String(this.repo),
      "base": this.head,
      "head": head
    }).ok);
    this.assertTrue(this.call("verify-commits", {
      "repo": String(this.repo),
      "base": head,
      "head": head
    }).ok);
  }
}
if (require.main === module) suite(WorkflowTests, {
  "test_signed_commit_verified": !which("ssh-keygen") ? "SSH signing tool unavailable" : false
});
module.exports = {
  WorkflowTests
};
