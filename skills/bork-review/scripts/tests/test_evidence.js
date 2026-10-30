'use strict';

const {
  path: nodePath,
  P,
  Fixture,
  suite,
  enumerate,
  json,
  sha256
} = require('../../../../tests/support.js');
const {
  WorkflowTests
} = require("./test_workflow.js");
/* Exercise evidence collection, review reuse and automation with offline API fixtures. */
class EvidenceTests extends Fixture {
  /* Verify public helper behavior without GitHub access or AI workers. */
  setUp = WorkflowTests.prototype.setUp;
  tearDown = WorkflowTests.prototype.tearDown;
  git = WorkflowTests.prototype.git;
  call = WorkflowTests.prototype.call;
  save(name, data) {
    /* Write a fixture as a durable JSON artifact. */
    var path = P(this.root).join(name);
    path.writeText(json(data));
    return String(path);
  }
  api(pages, {
    graphql = false
  } = {}) {
    /* Install a fake gh that records arguments and returns configured raw pages. */
    var binary = P(this.root).join("bin");
    binary.mkdir({
      "exist_ok": true
    });
    var gh = P(binary).join("gh");
    gh.writeText("#!" + process.execPath + "\nconst fs=require(\"node:fs\");fs.writeFileSync(process.env.FAKE_ARGS,process.argv.join(\"\\n\"));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(process.env.FAKE_SLEEP||0)*1000);process.stdout.write(fs.readFileSync(process.env.FAKE_RESPONSE,\"utf8\"));process.exit(Number(process.env.FAKE_EXIT||0));\n");
    gh.chmod(493);
    this.env.PATH = String(binary) + nodePath.delimiter + process.env.PATH;
    this.env.FAKE_ARGS = String(P(this.root).join("args"));
    this.env.FAKE_RESPONSE = this.save("response.json", pages);
    var spec = Object.assign({}, {
      "host": "github.com",
      "repository": "owner/repo",
      "endpoint": "repos/owner/repo/issues/1/comments?per_page=100"
    });
    if (graphql) {
      Object.assign(spec, {
        "endpoint": "graphql",
        "query": "query($owner: String!, $name: String!, $endCursor: String) { repository(owner: $owner, name: $name) { items(first: 100, after: $endCursor) { nodes { id body } pageInfo { hasNextPage endCursor } } } }",
        "items_path": ["data", "repository", "items", "nodes"],
        "connection_path": ["data", "repository", "items"]
      });
    }
    return this.save("spec.json", spec);
  }
  snap(spec, {
    name = "snapshot.json",
    ...fields
  } = {}) {
    /* Fetch into a fresh snapshot path. */
    return this.call("snapshot", {
      "spec": spec,
      "path": String(P(this.root).join(name)),
      ...fields
    });
  }
  page(nodes, {
    more = false
  } = {}) {
    /* Build one GraphQL connection response. */
    return {
      data: {
        repository: {
          items: {
            nodes: nodes,
            pageInfo: {
              hasNextPage: more,
              endCursor: more ? "cursor" : null
            }
          }
        }
      }
    };
  }
  test_paginated_snapshot_and_compact_delta() {
    /* All pages are retained while unchanged bodies stay out of model output. */
    var spec = this.api([[{
      id: 2,
      body: "full body"
    }, {
      id: 1,
      body: "first"
    }], [{
      id: 3,
      body: "third"
    }]]);
    var first = this.snap(spec).result;
    this.assertEqual(first.changed_ids, ["1", "2", "3"]);
    this.assertNotIn("full body", json(first));
    var snapshot = JSON.parse(P(first.path).readText());
    this.assertEqual(snapshot.entries["2"].body, "full body");
    this.assertTrue(P(first.path + ".raw.json").exists());
    this.api([[{
      body: "third",
      id: 3
    }, {
      body: "full body",
      id: 2
    }, {
      body: "first",
      id: 1
    }]]);
    var second = this.snap(spec, {
      "name": "second.json",
      "previous": first.path
    }).result;
    this.assertEqual(second.event, "unchanged");
    this.api([[{
      id: 2,
      body: "edited"
    }, {
      id: 3,
      body: "third"
    }]]);
    var result = this.snap(spec, {
      "name": "third.json",
      "previous": second.path
    }).result;
    this.assertEqual(result.changed_ids, ["2"]);
    this.assertEqual(result.removed_ids, ["1"]);
    var args = P(this.root).join("args").readText();
    this.assertIn("--paginate", args);
    this.assertIn("--slurp", args);
    this.assertIn("GET", args);
  }
  test_partial_graphql_does_not_publish() {
    /* Errors, truncated pagination and nested omissions never replace complete data. */
    var spec = this.api([this.page([{
      id: "a"
    }], {
      "more": true
    }), this.page([{
      id: "b"
    }])], {
      "graphql": true
    });
    var first = this.snap(spec).result;
    this.assertEqual(first.count, 2);
    for (var [i, pages] of enumerate([[this.page([{
      id: "a"
    }], {
      "more": true
    })], [{
      errors: [{
        message: "unavailable"
      }],
      data: {}
    }], [this.page([{
      id: "a",
      comments: {
        nodes: [],
        pageInfo: {
          hasNextPage: true
        }
      }
    }])]])) {
      P(this.env.FAKE_RESPONSE).writeText(json(pages));
      var result = this.snap(spec, {
        "name": "bad-" + String(i) + ".json",
        "previous": first.path
      });
      this.assertFalse(result.ok);
      this.assertFalse(P(this.root).join("bad-" + String(i) + ".json").exists());
    }
    this.assertTrue(P(first.path).exists());
  }
  test_snapshot_failure_identity_and_timeout() {
    /* API errors, source changes and timeouts cannot masquerade as empty changes. */
    var spec = this.api([[{
      id: 1,
      body: "one"
    }]]);
    var first = this.snap(spec).result;
    this.env.FAKE_EXIT = "1";
    this.assertFalse(this.snap(spec, {
      "name": "error.json",
      "previous": first.path
    }).ok);
    this.env.FAKE_EXIT = "0";
    var changed = JSON.parse(P(spec).readText());
    changed.endpoint = "repos/owner/repo/issues/2/comments";
    P(spec).writeText(json(changed));
    this.assertFalse(this.snap(spec, {
      "name": "identity.json",
      "previous": first.path
    }).ok);
    this.env.FAKE_SLEEP = "2";
    this.assertFalse(this.snap(spec, {
      "name": "timeout.json",
      "seconds": 1
    }).ok);
    this.assertFalse(P(this.root).join("timeout.json").exists());
  }
  test_snapshot_accepts_legacy_empty_map_fingerprint() {
    /* A PHP snapshot with nested empty maps remains reusable by Node. */
    var spec = this.api([this.page([])], {
      "graphql": true
    });
    var source = JSON.parse(P(spec).readText());
    source.variables = {};
    source.metadata = {
      filters: {}
    };
    P(spec).writeText(json(source));
    const legacy = value => {
      /* Match PHP associative decoding for source fingerprint comparison. */
      if (typeof value === "object" && !Array.isArray(value)) {
        return Object.keys(value).length ? Object.fromEntries(Object.keys(value).sort().map(key => [key, legacy(value[key])])) : [];
      }
      if (Array.isArray(value)) {
        return value.map(item => legacy(item));
      }
      return value;
    };
    var digest = sha256(Buffer.from(String(json(legacy(source), {
      "separators": [",", ":"],
      "ensure_ascii": true
    }))));
    var previous = this.save("legacy.json", {
      complete: true,
      source_hash: digest,
      entries: {}
    });
    var result = this.snap(spec, {
      "name": "from-legacy.json",
      "previous": previous
    });
    this.assertTrue(result.ok, result);
    this.assertEqual(result.result.event, "unchanged");
    this.assertEqual(JSON.parse(P(this.root).join("from-legacy.json").readText()).entries, {});
  }
  test_mutation_and_conflicting_pagination_rejected() {
    /* Read-only collection refuses mutations and inconsistent duplicated IDs. */
    var spec = this.api([[{
      id: 1,
      body: "old"
    }], [{
      id: 1,
      body: "new"
    }]]);
    this.assertFalse(this.snap(spec).ok);
    var config = JSON.parse(P(spec).readText());
    Object.assign(config, {
      "endpoint": "graphql",
      "query": "mutation($owner: String!, $name: String!) { deleteThing }"
    });
    P(spec).writeText(json(config));
    this.assertFalse(this.snap(spec).ok);
  }
  test_brief_identity_and_idempotent_records() {
    /* Briefs preserve identity and uncertain retries cannot overwrite old results. */
    var session = this.save("session.json", Object.assign({}, {
      "run_id": "run",
      "worktree": String(this.repo),
      "branch": "main",
      "head": this.head,
      "base_sha": this.head,
      "pr_url": "https://github.com/owner/repo/pull/1",
      "base_repository": "owner/repo",
      "head_repository": "owner/repo"
    }));
    var path = String(P(this.root).join("brief.json"));
    this.assertTrue(this.call("brief", {
      "session": session,
      "path": path,
      "data": {
        role: "fix",
        cycle: 2
      }
    }).ok);
    this.assertEqual(JSON.parse(P(path).readText()).cycle, 2);
    this.assertFalse(this.call("brief", {
      "session": session,
      "path": path,
      "data": {
        role: "fix",
        run_id: "wrong"
      }
    }).ok);
    var log = String(P(this.root).join("follow-up.json"));
    this.assertEqual(this.call("record", {
      "path": log,
      "id": "reply:1",
      "data": {
        url: "one"
      }
    }).result.event, "recorded");
    this.assertEqual(this.call("record", {
      "path": log,
      "id": "reply:1",
      "data": {
        url: "one"
      }
    }).result.event, "unchanged");
    this.assertFalse(this.call("record", {
      "path": log,
      "id": "reply:1",
      "data": {
        url: "two"
      }
    }).ok);
    this.assertEqual(JSON.parse(P(log).readText())["reply:1"].url, "one");
  }
  test_review_reuse_and_invalidation() {
    /* Matching evidence allows candidates, but changes and divergence broaden review. */
    var review = this.save("review.json", {
      coverage: "full"
    });
    var identity = Object.assign({}, {
      "pr_url": "https://github.com/owner/repo/pull/1",
      "base_repository": "owner/repo",
      "head_repository": "owner/repo",
      "base_sha": this.head,
      "instruction_hash": "instructions",
      "intent_hash": "intent"
    });
    var old = this.save("baseline.json", Object.assign({}, identity, {
      "reviewed_head": this.head,
      "complete": true,
      "review_path": review
    }));
    var current = Object.assign({}, identity, {
      "branch": "main",
      "head": this.head,
      "context_complete": true
    });
    var path = this.save("current.json", current);
    const check = () => {
      /* Check the current fixture through the public helper. */
      return this.call("reuse-review", {
        "repo": String(this.repo),
        "previous": old,
        "current": path
      }).result.event;
    };
    this.assertEqual(check(), "reuse_candidate");
    P(this.repo).join("source.txt").writeText("changed");
    this.assertEqual(check(), "full_review");
    this.git("add", ".");
    this.git("commit", "-m", "fix: changed");
    current.head = this.git("rev-parse", "HEAD").trim();
    this.save("current.json", current);
    this.assertEqual(check(), "delta_candidate");
    for (var key of ["base_sha", "instruction_hash", "intent_hash", "pr_url"]) {
      this.save("current.json", Object.assign({}, current, {
        ...{
          [key]: "changed"
        }
      }));
      this.assertEqual(check(), "full_review");
    }
    this.save("current.json", current);
    P(review).unlink();
    this.assertEqual(check(), "full_review");
  }
  polling({
    mode = "follow_up",
    signals = null
  } = {}) {
    /* Create one immutable polling scope with fresh API evidence. */
    var spec = this.api([[{
      id: "pr",
      head: this.head,
      draft: false
    }]]);
    var scope = Object.assign({}, {
      "mode": mode,
      "head": this.head,
      "sources": {
        pr: spec
      },
      "signals": signals !== null ? signals : {
        ci: {
          kind: "check"
        },
        bot: {
          kind: "review"
        }
      }
    });
    if (mode === "promotion") {
      Object.assign(scope, {
        "event_id": "ready-event",
        "promotion_time": Math.trunc(Number(Date.now() / 1000))
      });
    }
    this.scope = this.save("scope.json", scope);
    this.state = String(P(this.root).join("poll-state.json"));
    return this.poll();
  }
  poll() {
    /* Poll a fixture source through the actual bounded snapshot collector. */
    return this.call("automation-poll", {
      "scope": this.scope,
      "state": this.state,
      "directory": String(this.root)
    });
  }
  assess(signals, extra = {}) {
    /* Supply evidence classifications tied to the exact complete poll. */
    var state = JSON.parse(P(this.state).readText());
    var assessment = Object.assign({}, {
      "evidence_hash": state.evidence_hash,
      "head": this.head,
      "draft": false,
      "activity_hash": "scoped-activity",
      "signals": signals
    });
    Object.assign(assessment, extra);
    var path = this.save("assessment.json", assessment);
    return this.call("automation-assess", {
      "scope": this.scope,
      "state": this.state,
      "assessment": path
    });
  }
  signal({
    status = "terminal",
    ...extra
  } = {}) {
    /* Build an explicit SHA-correlated signal. */
    return Object.assign({}, {
      "head": this.head,
      "status": status,
      "evidence": ["fixture://result"],
      ...extra
    });
  }
  test_missing_pending_failure_and_completion() {
    /* Missing checks stay pending and failed checks return review feedback. */
    this.assertEqual(this.polling().result.event, "changed");
    this.assertEqual(this.assess({}).result.event, "waiting");
    var result = this.assess({
      ci: this.signal(),
      bot: this.signal({
        "status": "pending",
        "started": true
      })
    });
    this.assertEqual(result.result.event, "waiting");
    this.assertFalse(this.assess({
      ci: this.signal(),
      bot: this.signal()
    }).ok);
    result = this.assess({
      ci: this.signal({
        "failed": true
      }),
      bot: this.signal({
        "started": true,
        "completed_review": true
      })
    });
    this.assertEqual(result.result.event, "complete");
    this.assertEqual(result.result.failed_checks, ["ci"]);
    this.assertEqual(this.poll().result.event, "complete");
  }
  test_poll_changes_invalidate_assessment() {
    /* New source evidence requires reassessment; draft and SHA changes remain visible. */
    this.polling();
    var signals = {
      ci: this.signal(),
      bot: this.signal({
        "completed_review": true
      })
    };
    this.assertEqual(this.assess(signals).result.event, "complete");
    P(this.env.FAKE_RESPONSE).writeText(json([[{
      id: "pr",
      head: this.head,
      draft: true
    }]]));
    this.assertEqual(this.poll().result.event, "changed");
    this.assertEqual(this.assess(signals, {
      "draft": true
    }).result.event, "skipped_draft");
    this.assertFalse(this.assess(signals, {
      "head": "unexpected"
    }).ok);
    this.assertFalse(this.assess(signals, {
      "evidence_hash": "stale"
    }).ok);
  }
  test_quiet_period_and_infrastructure_failure() {
    /* Quiet completion requires elapsed quiet time and never accepts review failures. */
    this.polling({
      "signals": {
        ci: {
          kind: "check"
        }
      }
    });
    this.assertEqual(this.assess({
      ci: this.signal()
    }).result.event, "waiting");
    var state = JSON.parse(P(this.state).readText());
    state.quiet_since -= 121;
    P(this.state).writeText(json(state));
    this.assertEqual(this.poll().result.event, "complete");
    P(this.state).unlink();
    this.polling();
    this.assertFalse(this.assess({
      ci: this.signal(),
      bot: this.signal({
        "completed_review": true,
        "failed": true
      })
    }).ok);
  }
  test_promotion_correlation_start_deadline_and_pending() {
    /* Promotion rejects old events and expires only work that never started. */
    this.polling({
      "mode": "promotion",
      "signals": {
        bot: {
          kind: "review"
        }
      }
    });
    this.assertFalse(this.assess({
      bot: this.signal({
        "completed_review": true,
        "event_id": "old-event"
      })
    }).ok);
    this.assertEqual(this.assess({
      bot: this.signal({
        "status": "pending",
        "started": true,
        "started_at": Math.trunc(Number(Date.now() / 1000)) - 602,
        "event_id": "ready-event"
      })
    }).result.event, "waiting");
    var scope = JSON.parse(P(this.scope).readText());
    scope.promotion_time = Math.trunc(Number(Date.now() / 1000)) - 601;
    P(this.scope).writeText(json(scope));
    this.assertFalse(this.poll().ok);
    P(this.state).unlink();
    this.poll();
    this.assertFalse(this.assess({}).ok);
    this.assertFalse(this.assess({
      bot: this.signal({
        "status": "pending",
        "started": true,
        "started_at": Math.trunc(Number(Date.now() / 1000)),
        "event_id": "ready-event"
      })
    }).ok);
    this.assertEqual(this.assess({
      bot: this.signal({
        "status": "pending",
        "started": true,
        "started_at": Math.trunc(Number(Date.now() / 1000)) - 602,
        "event_id": "ready-event"
      })
    }).result.event, "waiting");
    this.assertEqual(this.assess({
      bot: this.signal({
        "started": true,
        "completed_review": true,
        "started_at": Math.trunc(Number(Date.now() / 1000)) - 602,
        "event_id": "ready-event"
      })
    }).result.event, "complete");
  }
}
if (require.main === module) suite(EvidenceTests, {});
module.exports = {
  EvidenceTests
};
