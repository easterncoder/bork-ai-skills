'use strict';

const {
  P,
  Fixture,
  suite,
  run,
  background,
  temporary,
  range,
  json,
  sha256,
  pop
} = require('../../../../tests/support.js');
/* Offline failure injection for the durable batch transition journal. */
var HELPER = P(P(__filename).resolve().parents[1]).join("batch.js");
var PR = "https://github.com/example/project/pull/12";
var HEAD = "a".repeat(40);
class BatchTests extends Fixture {
  /* Run the public JavaScript helper with disposable local records only. */
  setUp() {
    /* Create an empty batch directory with no GitHub or Git dependency. */
    this.temp = temporary({
      "prefix": "batch-state-"
    });
    this.addCleanup(this.temp.cleanup);
    this.root = P(this.temp.name);
    this.plan = P(this.root).join("plan.json");
    this.counter = 0;
    this.revision = 0;
  }
  call(action, fields = {}) {
    /* Call one transition and track its saved revision after success. */
    this.counter += 1;
    var source = P(this.root).join("input-" + String(this.counter) + ".json");
    var payload = {
      action: action,
      plan_path: String(this.plan),
      ...fields
    };
    if (!["init", "inspect"].includes(action) && !Object.hasOwn(payload, "expected_revision")) {
      payload.expected_revision = this.revision;
    }
    source.writeText(json(payload));
    var childProcess = run([process.execPath, String(HELPER), String(source)], {
      "capture_output": true,
      "text": true,
      "timeout": 10
    });
    var output = JSON.parse(childProcess.stdout);
    this.assertEqual(childProcess.status, output.ok ? 0 : 1, childProcess.stderr);
    if (output.ok && Object.hasOwn(output.result, "state_revision")) {
      this.revision = output.result.state_revision;
    }
    return output;
  }
  write(name, content) {
    /* Publish a fake durable worker or remote evidence record. */
    var path = P(this.root).join(name);
    path.writeText(json(content));
    return String(path);
  }
  approved_plan({
    merge = false,
    no_reviewer = false
  } = {}) {
    /* Build the exact approved preview and normalized single-target queue. */
    var preview = "issue 12, serial, native, merge=" + String(merge) + ", NOREVIEWER=" + String(no_reviewer);
    return {
      schema_version: 5,
      batch_id: "offline-12",
      approved_preview: preview,
      approval_evidence: {
        response: "go",
        preview_sha256: sha256(Buffer.from(String(preview)))
      },
      max_concurrency: 1,
      merge_enabled: merge,
      skip_ready_goodcode: no_reviewer,
      reviewer: no_reviewer ? "NONE" : "custom-reviewer",
      targets: {
        "12": {
          status: "queued",
          depends_on: [],
          entry_phase: "prify",
          issue_url: "https://github.com/example/project/issues/12",
          implementation_repository: "example/project"
        }
      }
    };
  }
  test_init_requires_entry_phase_fields() {
    /* Reject incomplete phase inputs before a plan or master can be created. */
    const requirements = {
      prify: ["issue_url", "implementation_repository"],
      draft_goodcode: ["pr_url"],
      draft: ["pr_url"],
      ready: ["pr_url"],
      finalize_merge: ["pr_url", "published_head"]
    };
    for (const [phase, fields] of Object.entries(requirements)) {
      for (const field of fields) {
        for (const invalid of [undefined, null, "", "   ", 12, false, []]) {
          const plan = this.approved_plan();
          Object.assign(plan.targets["12"], {entry_phase: phase, pr_url: PR, published_head: HEAD});
          if (invalid === undefined) delete plan.targets["12"][field];
          else plan.targets["12"][field] = invalid;
          const result = this.call("init", {plan: plan});
          this.assertFalse(result.ok, phase + ": " + field);
          this.assertTrue(result.error.includes(field), result.error);
          this.assertTrue(result.error.includes(phase), result.error);
          this.assertFalse(this.plan.exists());
        }
      }
      const plan = this.approved_plan();
      Object.assign(plan.targets["12"], {entry_phase: phase, pr_url: PR});
      if (phase === "finalize_merge") plan.targets["12"].published_head = HEAD;
      this.assertTrue(this.call("init", {plan: plan}).ok, phase);
      this.plan.unlink();
    }
  }
  test_init_rejects_unknown_or_missing_entry_phase() {
    /* Require an explicit supported phase instead of guessing a launch contract. */
    for (const phase of [undefined, null, "", "   ", "unknown", 12]) {
      const plan = this.approved_plan();
      if (phase === undefined) delete plan.targets["12"].entry_phase;
      else plan.targets["12"].entry_phase = phase;
      const result = this.call("init", {plan: plan});
      this.assertFalse(result.ok);
      this.assertTrue(result.error.includes("entry_phase"), result.error);
      this.assertFalse(this.plan.exists());
    }
  }
  start({
    merge = false,
    no_reviewer = false
  } = {}) {
    /* Approve, reserve, and attach the one simulated master. */
    this.assertTrue(this.call("init", {
      "plan": this.approved_plan({
        "merge": merge,
        "no_reviewer": no_reviewer
      })
    }).ok);
    this.assertEqual(this.call("reserve").result.launch, ["12"]);
    this.assertTrue(this.call("started", {
      "target_id": "12",
      "agent_id": "master-1"
    }).ok);
  }
  child(phase, {
    head = HEAD
  } = {}) {
    /* Simulate a child that wrote its result before its parent crashed. */
    var path = String(P(this.root).join(String(phase) + ".json"));
    var fields = {
      target_id: "12",
      phase: phase,
      result_path: path
    };
    if (!(phase === "prify")) {
      fields.pr_url = PR;
    }
    this.assertTrue(this.call("phase-start", {
      ...fields
    }).ok);
    var result = {
      phase: phase,
      status: "complete",
      pr_url: PR,
      published_head: head,
      cleanup_success: true
    };
    if (!(phase === "prify")) {
      Object.assign(result, {
        "reviewed_head": head,
        "workers_stopped": true
      });
    }
    this.write(String(phase) + ".json", result);
    return path;
  }
  adopt(phase, {
    head = HEAD
  } = {}) {
    /* Reconcile the already published child result against remote facts. */
    return this.call("phase-adopt", {
      "target_id": "12",
      "phase": phase,
      "agent_stopped": true,
      "descendants_stopped": true,
      "remote": {
        pr_url: PR,
        head: head
      }
    });
  }
  blocked_resume() {
    /* Retain a pending original child and construct explicit recovery evidence. */
    this.start({
      "no_reviewer": true
    });
    var path = this.child("prify");
    this.write("prify.json", {
      phase: "prify",
      status: "blocked",
      pr_url: PR,
      published_head: HEAD
    });
    this.assertTrue(this.call("target-blocked", {
      "target_id": "12",
      "master_stopped": true,
      "descendants_stopped": true,
      "reason": "original blocker",
      "evidence_path": path
    }).ok);
    var plan = JSON.parse(this.plan.readText());
    var remote = {
      pr_url: PR,
      head: HEAD,
      state: "OPEN",
      is_draft: true
    };
    var evidence = {
      batch_id: plan.batch_id,
      target_id: "12",
      approved_preview_sha256: sha256(Buffer.from(String(plan.approved_preview))),
      prior_master_agent_id: "master-1",
      recovered_master_agent_id: "master-2",
      user_instruction: "continue the same approved work",
      user_continuation: true,
      scope_unchanged: true,
      prior_master_stopped: true,
      children_reconciled: true,
      remote: remote
    };
    return [plan, evidence, remote];
  }
  test_target_resume_preserves_pending_phase_and_blocker() {
    /* Resume the same original result without replaying phase or publication intent. */
    var [before, evidence, remote] = this.blocked_resume();
    var path = this.write("resume.json", evidence);
    this.assertTrue(this.call("target-resume", {
      "target_id": "12",
      "agent_id": "master-2",
      "evidence_path": path,
      "remote": remote
    }).ok);
    var after = JSON.parse(this.plan.readText());
    this.assertEqual(after.state_revision, before.state_revision + 1);
    var target = after.targets["12"];
    this.assertEqual(target.status, "running");
    this.assertEqual(target.master_agent_id, "master-2");
    this.assertEqual(target.blocker, before.targets["12"].blocker);
    this.assertEqual(target.phase_records, before.targets["12"].phase_records);
    this.assertEqual(target.resume_history[0].blocker, target.blocker);
    for (var key of Object.keys(before)) {
      if (!["targets", "state_revision"].includes(key)) {
        this.assertEqual(after[key], before[key]);
      }
    }
    this.write("prify.json", {
      phase: "prify",
      status: "complete",
      pr_url: PR,
      published_head: HEAD,
      cleanup_success: true
    });
    this.assertTrue(this.adopt("prify").ok);
  }
  test_target_resume_preserves_history_and_rejects_linked_evidence() {
    /* Keep completed intents and older recovery history while rejecting linked records. */
    var [before, evidence, remote] = this.blocked_resume();
    var target = before.targets["12"];
    target.mutations = {
      review_request: {
        status: "complete",
        head: HEAD
      }
    };
    target.resume_history = [{
      blocker: {
        reason: "older blocker"
      },
      evidence_path: "older.json"
    }];
    this.plan.writeText(json(before));
    var path = this.write("resume.json", evidence);
    var linked = P(this.root).join("linked-resume.json");
    linked.symlinkTo(path);
    this.assertFalse(this.call("target-resume", {
      "target_id": "12",
      "agent_id": "master-2",
      "evidence_path": String(linked),
      "remote": remote
    }).ok);
    this.assertEqual(JSON.parse(this.plan.readText()), before);
    this.assertTrue(this.call("target-resume", {
      "target_id": "12",
      "agent_id": "master-2",
      "evidence_path": path,
      "remote": remote
    }).ok);
    var after = JSON.parse(this.plan.readText()).targets["12"];
    this.assertEqual(after.mutations, target.mutations);
    this.assertEqual(after.resume_history.slice(0, -1), target.resume_history);
    this.assertEqual(after.resume_history.at(-1).evidence_sha256, sha256(P(path).readBytes()));
  }
  test_target_resume_rejects_unverified_continuation() {
    /* Reject stale, active-owner, changed-scope and mismatched-remote recovery. */
    var [before, evidence, remote] = this.blocked_resume();
    for (var [field, value] of [["user_continuation", false], ["prior_master_stopped", false], ["scope_unchanged", false], ["children_reconciled", false], ["prior_master_agent_id", "unrelated"], ["approved_preview_sha256", "wrong"]]) {
      var path = this.write("resume.json", {
        ...evidence,
        [field]: value
      });
      this.assertFalse(this.call("target-resume", {
        "target_id": "12",
        "agent_id": "master-2",
        "evidence_path": path,
        "remote": remote
      }).ok);
      this.assertEqual(JSON.parse(this.plan.readText()), before);
    }
    path = this.write("resume.json", evidence);
    this.assertFalse(this.call("target-resume", {
      "target_id": "12",
      "agent_id": "master-2",
      "evidence_path": path,
      "remote": remote,
      "expected_revision": 0
    }).ok);
    this.assertFalse(this.call("target-resume", {
      "target_id": "12",
      "agent_id": "master-2",
      "evidence_path": String(P(this.root).join("missing.json")),
      "remote": remote
    }).ok);
    this.assertFalse(this.call("target-resume", {
      "target_id": "12",
      "agent_id": "master-2",
      "evidence_path": path,
      "remote": {
        ...remote,
        head: "b".repeat(40)
      }
    }).ok);
  }
  test_target_resume_rejects_pending_mutation_and_capacity() {
    /* Never revive blocked targets over uncertain external actions or occupied slots. */
    var [before, evidence, remote] = this.blocked_resume();
    var path = this.write("resume.json", evidence);
    for (var change of ["mutation", "capacity", "dependency", "nonblocked"]) {
      var plan = JSON.parse(json(before));
      if (change === "mutation") {
        plan.targets["12"].mutations = {
          ready: {
            status: "pending"
          }
        };
      } else {
        if (change === "capacity") {
          plan.targets["13"] = {
            status: "running",
            depends_on: []
          };
        } else {
          if (change === "dependency") {
            plan.targets["13"] = {
              status: "blocked",
              depends_on: []
            };
            plan.targets["12"].depends_on = ["13"];
          } else {
            plan.targets["12"].status = "running";
          }
        }
      }
      this.plan.writeText(json(plan));
      this.assertFalse(this.call("target-resume", {
        "target_id": "12",
        "agent_id": "master-2",
        "evidence_path": path,
        "remote": remote
      }).ok);
      this.assertEqual(JSON.parse(this.plan.readText()), plan);
    }
  }
  test_environment_selection_persistence_and_resume() {
    /* Retain the approved driver across a changed coordinator environment. */
    var plan = this.approved_plan();
    plan.execution_driver = "herdr";
    plan.environment_selection = {
      version: 1,
      execution_driver: "herdr",
      contexts: {
        herdr: {
          active: true,
          pane_id: "w1:p1",
          socket: "/tmp/herdr",
          shell_pid: 123
        },
        tmux: {
          active: false
        }
      },
      capability: {
        supported: true,
        evidence: "Verified terminal and native child capacity"
      }
    };
    this.assertTrue(this.call("init", {
      "plan": plan
    }).ok);
    this.assertTrue(this.call("reserve").ok);
    this.assertEqual(JSON.parse(this.plan.readText()).environment_selection, plan.environment_selection);
    this.assertTrue(this.call("inspect", {
      "target_id": "12"
    }).ok);
    this.assertEqual(JSON.parse(this.plan.readText()).execution_driver, "herdr");
  }
  test_screen_selection_persistence_and_resume() {
    /* Retain exact Screen resources through durable batch resume. */
    var plan = this.approved_plan();
    plan.execution_driver = "screen";
    plan.environment_selection = {
      version: 1,
      execution_driver: "screen",
      contexts: {
        herdr: {
          active: false
        },
        tmux: {
          active: false
        },
        screen: {
          active: true,
          pane_id: "0",
          socket: "123.fixture",
          session_id: "123.fixture",
          socket_dir: "/tmp/fixture",
          shell_pid: 124
        }
      },
      capability: {
        supported: true,
        evidence: "Verified Screen capacity"
      }
    };
    this.assertTrue(this.call("init", {
      "plan": plan
    }).ok);
    this.assertTrue(this.call("reserve").ok);
    this.assertTrue(this.call("inspect", {
      "target_id": "12"
    }).ok);
    var saved = JSON.parse(this.plan.readText());
    this.assertEqual(saved.execution_driver, "screen");
    this.assertEqual(saved.environment_selection, plan.environment_selection);
  }
  test_environment_selection_mismatch_is_rejected() {
    /* Refuse a driver inconsistent with its approved membership evidence. */
    var plan = this.approved_plan();
    plan.execution_driver = "tmux";
    plan.environment_selection = {
      version: 1,
      execution_driver: "native",
      contexts: {
        herdr: {
          active: false
        },
        tmux: {
          active: false
        }
      },
      capability: {
        supported: true,
        evidence: "native capacity"
      }
    };
    this.assertFalse(this.call("init", {
      "plan": plan
    }).ok);
    this.assertFalse(this.plan.exists());
  }
  test_legacy_driver_is_not_reselected() {
    /* An older approved native plan needs no new environment evidence. */
    var plan = this.approved_plan();
    plan.execution_driver = "native";
    this.assertTrue(this.call("init", {
      "plan": plan
    }).ok);
    this.assertTrue(this.call("reserve").ok);
    this.assertEqual(JSON.parse(this.plan.readText()).execution_driver, "native");
  }
  test_go_gate_and_atomic_reservation() {
    /* Reject an unapproved plan and stale concurrent queue changes. */
    var plan = this.approved_plan();
    plan.approval_evidence.response = "no-go";
    this.assertFalse(this.call("init", {
      "plan": plan
    }).ok);
    this.assertFalse(this.plan.exists());
    this.assertTrue(this.call("init", {
      "plan": this.approved_plan()
    }).ok);
    this.assertEqual(this.call("reserve").result.launch, ["12"]);
    this.assertFalse(this.call("reserve", {
      "expected_revision": 0
    }).ok);
    this.assertEqual(this.call("reserve").result.launch, []);
    this.assertEqual(JSON.parse(this.plan.readText()).targets["12"].status, "starting");
  }
  test_parallel_reservations_adopt_only_one_revision() {
    /* Two actual processes cannot reserve the same approved queue revision. */
    this.assertTrue(this.call("init", {
      "plan": this.approved_plan()
    }).ok);
    var expected = this.revision;
    var inputs = range(2).map(i => this.write("parallel-" + String(i) + ".json", {
      action: "reserve",
      plan_path: String(this.plan),
      expected_revision: expected
    }));
    var node = process.execPath;
    var processes = inputs.map(source => background([node, String(HELPER), source], {
      "stdout": null,
      "stderr": null,
      "text": true
    }));
    var replies = [];
    for (var childProcess of processes) {
      var [output, error] = childProcess.communicate({
        "timeout": 10
      });
      var reply = JSON.parse(output);
      this.assertEqual(childProcess.status, reply.ok ? 0 : 1, error);
      replies.push(reply);
    }
    this.assertEqual(replies.map(reply => reply.ok).reduce((sum, value) => sum + Number(value), 0), 1);
    var winner = replies.filter(reply => reply.ok).map(reply => reply).at(0);
    this.assertEqual(winner.result.launch, ["12"]);
    var saved = JSON.parse(this.plan.readText());
    this.assertEqual(saved.state_revision, expected + 1);
    this.assertEqual(saved.targets["12"].status, "starting");
  }
  test_push_and_pr_creation_crash_adopts_one_prify_result() {
    /* A lost master cannot launch a second prify after publication. */
    this.start();
    this.child("prify");
    this.assertEqual(this.call("inspect", {
      "target_id": "12"
    }).result.event, "reconcile_phase");
    this.assertFalse(this.call("phase-start", {
      "target_id": "12",
      "phase": "prify",
      "result_path": String(P(this.root).join("again.json"))
    }).ok);
    this.assertFalse(this.call("target-complete", {
      "target_id": "12",
      "result_path": String(P(this.root).join("none.json")),
      "master_stopped": true,
      "descendants_stopped": true
    }).ok);
    this.assertFalse(this.call("phase-adopt", {
      "target_id": "12",
      "phase": "prify",
      "agent_stopped": true,
      "descendants_stopped": true,
      "remote": {
        pr_url: PR,
        head: "b".repeat(40)
      }
    }).ok);
    this.assertTrue(this.adopt("prify").ok);
    this.assertFalse(this.adopt("prify").ok);
    this.assertEqual(JSON.parse(this.plan.readText()).targets["12"].pr_url, PR);
  }
  test_promotion_bot_gate_and_master_loss() {
    /* Each completed phase survives a master restart without replay. */
    this.start();
    this.child("prify");
    this.assertTrue(this.adopt("prify").ok);
    this.child("draft_goodcode");
    this.assertTrue(this.adopt("draft_goodcode").ok);
    this.assertEqual(this.call("mutation-start", {
      "target_id": "12",
      "kind": "ready",
      "pr_url": PR,
      "expected_head": HEAD
    }).result.event, "perform_once");
    this.assertEqual(this.call("inspect", {
      "target_id": "12"
    }).result.event, "reconcile_mutation");
    this.assertFalse(this.call("mutation-start", {
      "target_id": "12",
      "kind": "ready",
      "pr_url": PR,
      "expected_head": HEAD
    }).ok);
    this.assertFalse(this.call("mutation-observe", {
      "target_id": "12",
      "kind": "ready",
      "remote": {
        pr_url: PR,
        head: HEAD,
        is_draft: true
      }
    }).ok);
    this.assertTrue(this.call("mutation-observe", {
      "target_id": "12",
      "kind": "ready",
      "remote": {
        pr_url: PR,
        head: HEAD,
        is_draft: false
      }
    }).ok);
    this.assertFalse(this.call("phase-start", {
      "target_id": "12",
      "phase": "ready_goodcode",
      "pr_url": PR,
      "result_path": String(P(this.root).join("too-soon.json"))
    }).ok);
    var evidence = this.write("reviewer-gate.json", {
      status: "complete",
      pr_url: PR,
      head: HEAD,
      reviewer: "custom-reviewer"
    });
    this.assertTrue(this.call("gate-complete", {
      "target_id": "12",
      "evidence_path": evidence,
      "remote": {
        pr_url: PR,
        head: HEAD
      }
    }).ok);
    this.assertFalse(this.call("gate-complete", {
      "target_id": "12",
      "evidence_path": evidence,
      "remote": {
        pr_url: PR,
        head: HEAD
      }
    }).ok);
    this.child("ready_goodcode");
    this.assertTrue(this.adopt("ready_goodcode").ok);
    var report = this.write("target-result.json", {
      status: "complete",
      pr_url: PR,
      published_head: HEAD,
      cleanup_success: true
    });
    this.assertFalse(this.call("target-complete", {
      "target_id": "12",
      "result_path": report,
      "master_stopped": false,
      "descendants_stopped": true,
      "remote": {
        pr_url: PR,
        head: HEAD
      }
    }).ok);
    this.assertTrue(this.call("target-complete", {
      "target_id": "12",
      "result_path": report,
      "master_stopped": true,
      "descendants_stopped": true,
      "remote": {
        pr_url: PR,
        head: HEAD
      }
    }).ok);
    this.assertEqual(JSON.parse(this.plan.readText()).targets["12"].status, "complete");
  }
  test_legacy_reviewer_gate_resumes_without_repeating() {
    /* Old gate records permit continuation while rejecting a second request gate. */
    this.start();
    this.child("prify");
    this.assertTrue(this.adopt("prify").ok);
    var evidence = this.write("reviewer-gate.json", {
      status: "complete",
      pr_url: PR,
      head: HEAD,
      reviewer: "custom-reviewer"
    });
    this.assertTrue(this.call("gate-complete", {
      "target_id": "12",
      "evidence_path": evidence,
      "remote": {
        pr_url: PR,
        head: HEAD
      }
    }).ok);
    var plan = JSON.parse(this.plan.readText());
    var records = plan.targets["12"].phase_records;
    this.assertIn("reviewer_gate", records);
    this.assertNotIn("cspf", records);
    records.cspf = pop(records, "reviewer_gate");
    this.plan.writeText(json(plan));
    this.assertFalse(this.call("gate-complete", {
      "target_id": "12",
      "evidence_path": evidence,
      "remote": {
        pr_url: PR,
        head: HEAD
      }
    }).ok);
    this.child("ready_goodcode");
    this.assertTrue(this.adopt("ready_goodcode").ok);
  }
  test_uncertain_merge_is_never_repeated() {
    /* A lost merge response stays pending until remote evidence is checked. */
    this.start({
      "merge": true
    });
    this.child("prify");
    this.assertTrue(this.adopt("prify").ok);
    this.child("draft_goodcode");
    this.assertTrue(this.adopt("draft_goodcode").ok);
    this.assertTrue(this.call("mutation-start", {
      "target_id": "12",
      "kind": "ready",
      "pr_url": PR,
      "expected_head": HEAD
    }).ok);
    this.assertTrue(this.call("mutation-observe", {
      "target_id": "12",
      "kind": "ready",
      "remote": {
        pr_url: PR,
        head: HEAD,
        is_draft: false
      }
    }).ok);
    var evidence = this.write("reviewer-gate.json", {
      status: "complete",
      pr_url: PR,
      head: HEAD,
      reviewer: "custom-reviewer"
    });
    this.assertTrue(this.call("gate-complete", {
      "target_id": "12",
      "evidence_path": evidence,
      "remote": {
        pr_url: PR,
        head: HEAD
      }
    }).ok);
    this.child("ready_goodcode");
    this.assertTrue(this.adopt("ready_goodcode").ok);
    var report = this.write("target-result.json", {
      status: "complete",
      pr_url: PR,
      published_head: HEAD,
      cleanup_success: true
    });
    this.assertTrue(this.call("target-complete", {
      "target_id": "12",
      "result_path": report,
      "master_stopped": true,
      "descendants_stopped": true,
      "remote": {
        pr_url: PR,
        head: HEAD
      }
    }).ok);
    this.assertTrue(this.call("mutation-start", {
      "target_id": "12",
      "kind": "merge",
      "pr_url": PR,
      "expected_head": HEAD
    }).ok);
    this.assertEqual(this.call("inspect", {
      "target_id": "12"
    }).result.event, "reconcile_mutation");
    this.assertFalse(this.call("mutation-start", {
      "target_id": "12",
      "kind": "merge",
      "pr_url": PR,
      "expected_head": HEAD
    }).ok);
    this.assertTrue(this.call("merge-running", {
      "target_id": "12"
    }).ok);
    this.assertFalse(this.call("merge-running", {
      "target_id": "12"
    }).ok);
    this.assertFalse(this.call("mutation-observe", {
      "target_id": "12",
      "kind": "merge",
      "remote": {
        pr_url: PR,
        head: HEAD,
        merged: false
      }
    }).ok);
    var observed = {
      pr_url: PR,
      head: HEAD,
      merged: true,
      merge_commit_url: "https://github.com/example/project/commit/" + HEAD
    };
    this.assertTrue(this.call("mutation-observe", {
      "target_id": "12",
      "kind": "merge",
      "remote": observed
    }).ok);
    this.assertEqual(JSON.parse(this.plan.readText()).targets["12"].merge_status, "merged");
  }
  test_blocked_target_releases_slot_only_after_agents_stop() {
    /* Failure evidence cannot free a running slot while a child survives. */
    this.start();
    var evidence = this.write("blocked.json", {
      status: "blocked",
      reason: "push outcome unknown"
    });
    this.assertFalse(this.call("target-blocked", {
      "target_id": "12",
      "reason": "push outcome unknown",
      "evidence_path": evidence,
      "master_stopped": true,
      "descendants_stopped": false
    }).ok);
    this.assertEqual(this.call("reserve").result.launch, []);
    this.assertTrue(this.call("target-blocked", {
      "target_id": "12",
      "reason": "push outcome unknown",
      "evidence_path": evidence,
      "master_stopped": true,
      "descendants_stopped": true
    }).ok);
    this.assertEqual(JSON.parse(this.plan.readText()).targets["12"].status, "blocked");
  }
  test_uncertain_merge_can_be_blocked_only_after_unmerged_observation() {
    /* A failed merge attempt retains its intent and requires remote reconciliation. */
    this.start({
      "merge": true
    });
    this.child("prify");
    this.assertTrue(this.adopt("prify").ok);
    this.child("draft_goodcode");
    this.assertTrue(this.adopt("draft_goodcode").ok);
    this.assertTrue(this.call("mutation-start", {
      "target_id": "12",
      "kind": "ready",
      "pr_url": PR,
      "expected_head": HEAD
    }).ok);
    this.assertTrue(this.call("mutation-observe", {
      "target_id": "12",
      "kind": "ready",
      "remote": {
        pr_url: PR,
        head: HEAD,
        is_draft: false
      }
    }).ok);
    var evidence = this.write("reviewer-gate.json", {
      status: "complete",
      pr_url: PR,
      head: HEAD,
      reviewer: "custom-reviewer"
    });
    this.assertTrue(this.call("gate-complete", {
      "target_id": "12",
      "evidence_path": evidence,
      "remote": {
        pr_url: PR,
        head: HEAD
      }
    }).ok);
    this.child("ready_goodcode");
    this.assertTrue(this.adopt("ready_goodcode").ok);
    var report = this.write("target-result.json", {
      status: "complete",
      pr_url: PR,
      published_head: HEAD,
      cleanup_success: true
    });
    this.assertTrue(this.call("target-complete", {
      "target_id": "12",
      "result_path": report,
      "master_stopped": true,
      "descendants_stopped": true,
      "remote": {
        pr_url: PR,
        head: HEAD
      }
    }).ok);
    this.assertTrue(this.call("mutation-start", {
      "target_id": "12",
      "kind": "merge",
      "pr_url": PR,
      "expected_head": HEAD
    }).ok);
    this.assertFalse(this.call("merge-blocked", {
      "target_id": "12",
      "reason": "mergeability unknown"
    }).ok);
    this.assertTrue(this.call("merge-blocked", {
      "target_id": "12",
      "reason": "mergeability unknown",
      "remote": {
        pr_url: PR,
        head: HEAD,
        merged: false
      }
    }).ok);
    this.assertFalse(this.call("mutation-start", {
      "target_id": "12",
      "kind": "merge",
      "pr_url": PR,
      "expected_head": HEAD
    }).ok);
  }
  test_noreviewer_skips_external_gate_and_ready_run() {
    /* The approved skip requires draft work and promotion without external review. */
    this.start({
      "no_reviewer": true
    });
    this.child("prify");
    this.assertTrue(this.adopt("prify").ok);
    this.child("draft_goodcode");
    this.assertTrue(this.adopt("draft_goodcode").ok);
    this.assertTrue(this.call("mutation-start", {
      "target_id": "12",
      "kind": "ready",
      "pr_url": PR,
      "expected_head": HEAD
    }).ok);
    this.assertTrue(this.call("mutation-observe", {
      "target_id": "12",
      "kind": "ready",
      "remote": {
        pr_url: PR,
        head: HEAD,
        is_draft: false
      }
    }).ok);
    this.assertFalse(this.call("phase-start", {
      "target_id": "12",
      "phase": "ready_goodcode",
      "result_path": String(P(this.root).join("ready.json"))
    }).ok);
    var report = this.write("target-result.json", {
      status: "complete",
      pr_url: PR,
      published_head: HEAD,
      cleanup_success: true,
      ready_goodcode_status: "skipped_noreviewer"
    });
    var remote = {
      pr_url: PR,
      head: HEAD,
      is_draft: false
    };
    this.assertTrue(this.call("target-complete", {
      "target_id": "12",
      "result_path": report,
      "master_stopped": true,
      "descendants_stopped": true,
      "remote": remote
    }).ok);
    this.assertEqual(JSON.parse(this.plan.readText()).targets["12"].merge_status, "skipped_not_requested");
  }
  test_noreviewer_and_domerge_use_applicable_completed_phases() {
    /* The approved merge intent can proceed after the skipped ready phase. */
    this.start({
      "merge": true,
      "no_reviewer": true
    });
    this.child("prify");
    this.assertTrue(this.adopt("prify").ok);
    this.child("draft_goodcode");
    this.assertTrue(this.adopt("draft_goodcode").ok);
    this.assertTrue(this.call("mutation-start", {
      "target_id": "12",
      "kind": "ready",
      "pr_url": PR,
      "expected_head": HEAD
    }).ok);
    var remote = {
      pr_url: PR,
      head: HEAD,
      is_draft: false
    };
    this.assertTrue(this.call("mutation-observe", {
      "target_id": "12",
      "kind": "ready",
      "remote": remote
    }).ok);
    var report = this.write("target-result.json", {
      status: "complete",
      pr_url: PR,
      published_head: HEAD,
      cleanup_success: true,
      ready_goodcode_status: "skipped_noreviewer"
    });
    this.assertTrue(this.call("target-complete", {
      "target_id": "12",
      "result_path": report,
      "master_stopped": true,
      "descendants_stopped": true,
      "remote": remote
    }).ok);
    this.assertEqual(this.call("mutation-start", {
      "target_id": "12",
      "kind": "merge",
      "pr_url": PR,
      "expected_head": HEAD
    }).result.event, "perform_once");
    this.assertFalse(this.call("mutation-start", {
      "target_id": "12",
      "kind": "merge",
      "pr_url": PR,
      "expected_head": HEAD
    }).ok);
  }
  test_default_reviewer_and_arbitrary_values() {
    /* New plans default to NONE and preserve arbitrary reviewer names. */
    var plan = this.approved_plan();
    delete plan.reviewer;
    delete plan.skip_ready_goodcode;
    this.assertTrue(this.call("init", {
      "plan": plan
    }).ok);
    var saved = JSON.parse(this.plan.readText());
    this.assertEqual(saved.reviewer, "NONE");
    this.assertTrue(saved.skip_ready_goodcode);
    this.plan.unlink();
    for (var reviewer of ["some-user", "org/team", "review-bot[bot]", "none"]) {
      plan = this.approved_plan();
      plan.reviewer = reviewer;
      this.assertTrue(this.call("init", {
        "plan": plan
      }).ok);
      this.assertEqual(JSON.parse(this.plan.readText()).reviewer, reviewer);
      this.plan.unlink();
    }
    plan.reviewer = "NONE";
    this.assertFalse(this.call("init", {
      "plan": plan
    }).ok);
  }
  test_review_profile_defaults_and_validates() {
    /* New plans default to the generic profile and reject unknown profiles. */
    this.assertTrue(this.call("init", {
      "plan": this.approved_plan()
    }).ok);
    this.assertEqual(JSON.parse(this.plan.readText()).review_profile, "generic");
    this.plan.unlink();
    var plan = this.approved_plan();
    var profile = P(this.root).join("profile.md");
    profile.writeText("# Supplied rules\n");
    plan.review_profile = String(profile);
    this.assertFalse(this.call("init", {
      "plan": plan
    }).ok);
    plan.review_profile_sha256 = sha256(profile.readBytes());
    this.assertTrue(this.call("init", {
      "plan": plan
    }).ok);
    this.assertEqual(JSON.parse(this.plan.readText()).review_profile, String(profile));
    this.plan.unlink();
    profile.writeText("# Changed rules\n");
    this.assertFalse(this.call("init", {
      "plan": plan
    }).ok);
    profile.unlink();
    this.assertFalse(this.call("init", {
      "plan": plan
    }).ok);
    plan.review_profile = "other";
    this.assertFalse(this.call("init", {
      "plan": plan
    }).ok);
  }
  test_effort_override_validates() {
    /* An optional effort override accepts only the three tier names. */
    for (var value of ["low", "standard", "high"]) {
      var plan = this.approved_plan();
      plan.effort_override = value;
      this.assertTrue(this.call("init", {
        "plan": plan
      }).ok);
      this.assertEqual(JSON.parse(this.plan.readText()).effort_override, value);
      this.plan.unlink();
    }
    plan.effort_override = "max";
    this.assertFalse(this.call("init", {
      "plan": plan
    }).ok);
  }
  start_ready({no_reviewer = false, fields = {}} = {}) {
    /* Start a ready-entry target without adopting an implementation phase. */
    var plan = this.approved_plan({no_reviewer: no_reviewer});
    Object.assign(plan.targets["12"], {entry_phase: "ready", pr_url: PR}, fields);
    this.assertTrue(this.call("init", {plan: plan}).ok);
    this.assertEqual(this.call("reserve").result.launch, ["12"]);
    this.assertTrue(this.call("started", {target_id: "12", agent_id: "master-1"}).ok);
  }
  test_ready_entry_resume_before_and_after_gate() {
    /* Resume with verified ready evidence while preserving any seeded head. */
    for (var stage of ["unseeded", "stale", "seeded"]) {
      var seeded = stage === "seeded";
      this.start_ready({fields: stage === "stale" ? {published_head: "b".repeat(40)} : {}});
      var remote = {pr_url: PR, head: HEAD, state: "OPEN", is_draft: false};
      if (seeded) {
        var gate = this.write("review.json", {
          status: "complete", pr_url: PR, head: HEAD, reviewer: "custom-reviewer"
        });
        this.assertTrue(this.call("gate-complete", {target_id: "12", evidence_path: gate, remote: remote}).ok);
      }
      var blocker = this.write("blocker.json", {reason: "review stalled"});
      this.assertTrue(this.call("target-blocked", {
        target_id: "12", master_stopped: true, descendants_stopped: true,
        reason: "review_stalled", evidence_path: blocker
      }).ok);
      var plan = JSON.parse(this.plan.readText());
      var evidence = {
        batch_id: plan.batch_id, target_id: "12",
        approved_preview_sha256: sha256(Buffer.from(String(plan.approved_preview))),
        prior_master_agent_id: "master-1", recovered_master_agent_id: "master-2",
        user_instruction: "continue", user_continuation: true, scope_unchanged: true,
        prior_master_stopped: true, children_reconciled: true, remote: remote
      };
      var path = this.write("resume-ready.json", evidence);
      for (var invalid of [
        {pr_url: PR + "0"}, {head: ""}, {state: "CLOSED"}, {is_draft: true},
        ...(seeded ? [{head: "b".repeat(40)}] : [])
      ]) {
        var bad = {...remote, ...invalid};
        this.write("resume-ready.json", {...evidence, remote: bad});
        this.assertFalse(this.call("target-resume", {
          target_id: "12", agent_id: "master-2", evidence_path: path, remote: bad
        }).ok);
      }
      this.write("resume-ready.json", evidence);
      this.assertFalse(this.call("target-resume", {
        target_id: "12", agent_id: "master-2", evidence_path: path,
        remote: {...remote, head: "b".repeat(40)}
      }).ok);
      this.assertTrue(this.call("target-resume", {
        target_id: "12", agent_id: "master-2", evidence_path: path, remote: remote
      }).ok);
      var target = JSON.parse(this.plan.readText()).targets["12"];
      this.assertEqual(target.status, "running");
      this.assertEqual(target.published_head ?? null, seeded ? HEAD : stage === "stale" ? "b".repeat(40) : null);
      this.plan.unlink();
      this.revision = 0;
    }
  }
  test_ready_entry_gate_and_completion() {
    /* Seed the live head at the gate and complete the normal ready workflow. */
    this.start_ready();
    var evidence = this.write("review.json", {
      status: "complete", pr_url: PR, head: HEAD, reviewer: "custom-reviewer"
    });
    var remote = {pr_url: PR, head: HEAD, state: "OPEN", is_draft: false};
    this.assertTrue(this.call("gate-complete", {
      target_id: "12", evidence_path: evidence, remote: remote
    }).ok);
    this.assertEqual(JSON.parse(this.plan.readText()).targets["12"].published_head, HEAD);
    this.child("ready_goodcode");
    this.assertTrue(this.adopt("ready_goodcode").ok);
    var result = this.write("target.json", {
      status: "complete", pr_url: PR, published_head: HEAD, cleanup_success: true
    });
    this.assertTrue(this.call("target-complete", {
      target_id: "12", result_path: result, master_stopped: true,
      descendants_stopped: true, remote: remote
    }).ok);
  }
  test_ready_entry_gate_rejects_invalid_remote_and_evidence() {
    /* Invalid observations cannot seed a head or leave a completed gate. */
    this.start_ready();
    var evidence = this.write("review.json", {
      status: "complete", pr_url: PR, head: HEAD, reviewer: "custom-reviewer"
    });
    var remote = {pr_url: PR, head: HEAD, state: "OPEN", is_draft: false};
    for (var invalid of [
      {head: "b".repeat(40)}, {head: ""}, {head: null},
      {pr_url: PR + "0"}, {state: "CLOSED"}, {state: null},
      {is_draft: true}, {is_draft: null}
    ]) {
      this.assertFalse(this.call("gate-complete", {
        target_id: "12", evidence_path: evidence, remote: {...remote, ...invalid}
      }).ok);
      var target = JSON.parse(this.plan.readText()).targets["12"];
      this.assertFalse(Object.hasOwn(target, "published_head"));
      this.assertFalse(Object.hasOwn(target.phase_records ?? {}, "reviewer_gate"));
    }
    this.write("review.json", {
      status: "complete", pr_url: PR, head: HEAD, reviewer: "other-user"
    });
    this.assertFalse(this.call("gate-complete", {
      target_id: "12", evidence_path: evidence, remote: remote
    }).ok);
  }
  test_ready_entry_without_reviewer_seeds_head_at_completion() {
    /* A skipped gate still records a verified ready head at completion. */
    this.start_ready({no_reviewer: true});
    var result = this.write("target.json", {
      status: "complete", pr_url: PR, published_head: HEAD,
      cleanup_success: true, ready_goodcode_status: "skipped_noreviewer"
    });
    var fields = {
      target_id: "12", result_path: result, master_stopped: true,
      descendants_stopped: true
    };
    var remote = {pr_url: PR, head: HEAD, state: "OPEN", is_draft: false};
    for (var invalid of [{head: "b".repeat(40)}, {pr_url: PR + "0"}, {state: "CLOSED"}, {state: null}, {head: ""}, {is_draft: true}]) {
      this.assertFalse(this.call("target-complete", {
        ...fields, remote: {...remote, ...invalid}
      }).ok);
      this.assertFalse(Object.hasOwn(JSON.parse(this.plan.readText()).targets["12"], "published_head"));
    }
    this.assertTrue(this.call("target-complete", {...fields, remote: remote}).ok);
    this.assertEqual(JSON.parse(this.plan.readText()).targets["12"].published_head, HEAD);
  }
  test_ready_entry_gate_refreshes_initial_head() {
    /* Approval-time heads are refreshed before any phase has completed. */
    this.start_ready({fields: {published_head: "b".repeat(40)}});
    var evidence = this.write("review.json", {
      status: "complete", pr_url: PR, head: HEAD, reviewer: "custom-reviewer"
    });
    this.assertTrue(this.call("gate-complete", {
      target_id: "12", evidence_path: evidence,
      remote: {pr_url: PR, head: HEAD, state: "OPEN", is_draft: false}
    }).ok);
    this.assertEqual(JSON.parse(this.plan.readText()).targets["12"].published_head, HEAD);
  }
  test_ready_entry_gate_preserves_phase_head() {
    /* Adopted phase heads cannot be refreshed by the ready-entry exception. */
    this.start_ready();
    this.child("prify");
    this.assertTrue(this.adopt("prify").ok);
    var changed = "b".repeat(40);
    var evidence = this.write("review.json", {
      status: "complete", pr_url: PR, head: changed, reviewer: "custom-reviewer"
    });
    this.assertFalse(this.call("gate-complete", {
      target_id: "12", evidence_path: evidence,
      remote: {pr_url: PR, head: changed, state: "OPEN", is_draft: false}
    }).ok);
    this.assertEqual(JSON.parse(this.plan.readText()).targets["12"].published_head, HEAD);
  }
  test_ready_pr_gate_rejects_wrong_reviewer() {
    /* An initially ready PR needs evidence from its selected reviewer. */
    this.start();
    this.child("prify");
    this.assertTrue(this.adopt("prify").ok);
    var evidence = this.write("review.json", {
      status: "complete",
      pr_url: PR,
      head: HEAD,
      reviewer: "other-user"
    });
    this.assertFalse(this.call("gate-complete", {
      "target_id": "12",
      "evidence_path": evidence,
      "remote": {
        pr_url: PR,
        head: HEAD
      }
    }).ok);
    this.write("review.json", {
      status: "complete",
      pr_url: PR,
      head: HEAD,
      reviewer: "custom-reviewer"
    });
    this.assertTrue(this.call("gate-complete", {
      "target_id": "12",
      "evidence_path": evidence,
      "remote": {
        pr_url: PR,
        head: HEAD
      }
    }).ok);
  }
}
if (require.main === module) suite(BatchTests, {});
module.exports = {
  BatchTests
};
