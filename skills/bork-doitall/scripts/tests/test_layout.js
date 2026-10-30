'use strict';

const {
  path: nodePath,
  P,
  Fixture,
  suite,
  run,
  checkOutput,
  temporary,
  which,
  range,
  json
} = require('../../../../tests/support.js');
/* Shared layout planning and isolated real tmux placement checks. */
var HELPER = P(P(__filename).resolve().parents[1]).join("layout.js");
var TMUX = HELPER.withName("tmux.js");
class LayoutTests extends Fixture {
  /* Verify topology, journaling and resource protection through public actions. */
  setUp() {
    /* Create private input files and a unique tmux server address. */
    this.temp = temporary({
      "prefix": "bork-layout-"
    });
    this.root = P(this.temp.name);
    this.socket = this.root.name;
    this.index = 0;
  }
  tearDown() {
    /* Stop only this fixture's private tmux server. */
    if (which("tmux")) {
      run(["tmux", "-L", this.socket, "kill-server"], {
        "capture_output": true
      });
    }
    this.temp.cleanup();
  }
  invoke(action, data, {
    helper = HELPER
  } = {}) {
    /* Invoke the public helper with an immutable JSON request. */
    this.index += 1;
    var path = P(this.root).join("input-" + String(this.index) + ".json");
    path.writeText(json(data));
    var proc = run([process.execPath, String(helper), action, String(path)], {
      "capture_output": true,
      "text": true,
      "timeout": 15
    });
    var result = JSON.parse(proc.stdout);
    this.assertEqual(proc.status, result.ok ? 0 : 1, proc.stderr);
    return result;
  }
  tmux(...args) {
    /* Address the isolated fixture server by its unique socket name. */
    return checkOutput(["tmux", "-L", this.socket, ...args], {
      "text": true
    }).trim();
  }
  create({
    count = 1
  } = {}) {
    /* Provision inside an existing coordinator pane beside unrelated work. */
    var coordinator = this.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "fixture", "-x", "260", "-y", "90");
    this.tmux("set-option", "-t", "fixture", "default-shell", "/bin/sh");
    this.tmux("set-option", "-t", "fixture", "default-command", "");
    var unrelated = this.tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-v", "-l", "10", "-t", coordinator);
    var data = {
      driver: "tmux",
      context: {
        socket: this.socket
      },
      coordinator: coordinator,
      concurrency: count,
      record: String(P(this.root).join("layout.json")),
      cwd: String(this.root),
      run_id: "fixture"
    };
    var result = this.invoke("create", data);
    this.assertTrue(result.ok, result);
    return [data, result.result, unrelated];
  }
  test_topology_for_all_concurrency_values() {
    /* Coordinator spans all rows and each review sits over its matching fix. */
    for (var count of [1, 2, 3]) {
      var result = this.invoke("plan", {
        concurrency: count,
        area: {
          x: 5,
          y: 7,
          width: 200,
          height: 80
        }
      });
      this.assertTrue(result.ok, result);
      var slots = result.result.slots;
      this.assertEqual(Object.keys(slots).length, 1 + count * 3);
      this.assertEqual(slots.coordinator.height, 80);
      var previous_bottom = 6;
      for (var slot of range(1, count + 1)) {
        var [master, review, fix] = ["master", "review", "fix"].map(role => slots[String(role) + ":" + String(slot)]);
        this.assertGreater(master.y, previous_bottom);
        this.assertEqual(master.y, review.y);
        this.assertGreater(review.x, master.x);
        this.assertEqual(review.x, fix.x);
        this.assertEqual(fix.y, review.y + review.height + 1);
        this.assertEqual(master.height, review.height + fix.height + 1);
        previous_bottom = master.y + master.height - 1;
      }
    }
  }
  test_insufficient_geometry_and_bad_limits() {
    /* Unusable sizes and invalid concurrency fail before driver mutation. */
    for (var count of [0, 4, "2", true]) {
      this.assertFalse(this.invoke("plan", {
        concurrency: count,
        area: {
          x: 0,
          y: 0,
          width: 180,
          height: 60
        }
      }).ok);
    }
    for (var [width, height] of [[60, 60], [200, 15]]) {
      this.assertFalse(this.invoke("plan", {
        concurrency: 3,
        area: {
          x: 0,
          y: 0,
          width: width,
          height: height
        }
      }).ok);
    }
  }
  test_headless_hc_does_not_call_app() {
    /* Headless capability is explicit and requires no app mutation or process. */
    var result = this.invoke("preflight", {
      driver: "hc"
    });
    this.assertTrue(result.ok);
    this.assertFalse(result.result.visual);
    this.assertTrue(result.result.supported);
  }
  test_herdr_adapter_command_and_identity_contract() {
    /* Use documented response fixtures to verify exact target and returned IDs. */
    var stub = P(this.root).join("herdr");
    var calls = P(this.root).join("calls.jsonl");
    var layout = {
      zoomed: false,
      tab_id: "w1:t1",
      workspace_id: "w1",
      focused_pane_id: "w1:p1",
      panes: [{
        pane_id: "w1:p1",
        rect: {
          x: 0,
          y: 0,
          width: 200,
          height: 80
        }
      }]
    };
    stub.writeText('#!' + process.execPath + '\nconst fs=require("node:fs");fs.appendFileSync(' + json(String(calls)) + ',JSON.stringify(process.argv.slice(2))+"\\n");const layout=' + json(layout) + ';const result=process.argv[2]==="pane"&&process.argv[3]==="layout"?{layout}:{pane:{pane_id:"w1:p2"}};console.log(JSON.stringify({result}));\n');
    stub.chmod(448);
    var record = {
      context: {},
      coordinator: "w1:p1",
      cwd: String(this.root),
      resources: {
        coordinator: {
          id: "w1:p1"
        }
      }
    };
    var code = "const a=require(require(\"node:path\").join(require(\"node:path\").dirname(process.argv[1]),\"layout-adapters/herdr.js\"));const r=JSON.parse(process.argv[2]);console.log(require(require(\"node:path\").resolve(require(\"node:path\").dirname(process.argv[1]), \"../../bork-review/scripts/support.js\")).json_encode([a.borkLayoutHerdrSnapshot([],\"w1:p1\"),a.borkLayoutHerdrSplit(r,{parent:\"coordinator\",direction:\"right\",size:150})]));";
    var env = {
      ...process.env,
      PATH: String(this.root) + nodePath.delimiter + process.env.PATH,
      HERDR_ENV: "1"
    };
    var result = run([process.execPath, "-e", code, String(HELPER), json(record)], {
      "env": env,
      "capture_output": true,
      "text": true,
      "timeout": 15
    });
    this.assertEqual(result.status, 0, result.stderr);
    var [snapshot, pane] = JSON.parse(result.stdout);
    this.assertEqual(snapshot.focus, "w1:p1");
    this.assertEqual(snapshot.panes["w1:p1"].width, 200);
    this.assertEqual(pane, "w1:p2");
    var split = JSON.parse(calls.readText().trimEnd().split(/\r?\n/).at(-1));
    this.assertEqual(split.slice(0, 6), ["pane", "split", "--pane", "w1:p1", "--direction", "right"]);
    this.assertIn("--no-focus", split);
    this.assertAlmostEqual(Number(split[split.indexOf("--ratio") + 1]), 50 / 200);
  }
  test_screen_traversal_stops_after_observed_navigation() {
    /* Replace only the host transport while executing the production navigation guard. */
    const script = `
      const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
      const file=path.join(path.dirname(process.argv[1]),'layout-adapters/screen.js');
      const sandbox={require:require('node:module').createRequire(file),module:{exports:{}},process};
      vm.runInNewContext(fs.readFileSync(file,'utf8') + \`
        let focused='entry', controls=[];
        borkLayoutScreenControl=function(context,args){
          if(args[0]==='-Q') return focused+' title';
          controls.push(args); focused=args[2]; return '';
        };
        const context={session:'fixture'};
        let blocked=false;
        try {
          screenNavigation(context,()=>{
            borkLayoutScreen(context,['-X','focus','temporary']);
            focused='user';
            try { borkLayoutScreen(context,['-X','resize','10']); }
            finally { borkLayoutScreen(context,['-X','focus','entry']); }
          });
        } catch(error) { blocked=error.message.includes('User navigated'); }
        if(!blocked || focused!=='user' || controls.length!==1 || navigation.size!==0) throw Error('Navigation guard failed');
      \`,sandbox);
    `;
    const result = run([process.execPath, '-e', script, String(HELPER)], {capture_output: true, text: true});
    this.assertEqual(result.status, 0, result.stderr);
  }
  test_screen_size_stops_when_navigation_occurs_during_resize() {
    /* Exercise the size operation with navigation during the transport call. */
    const script = `
      const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
      const file=path.join(path.dirname(process.argv[1]),'layout-adapters/screen.js');
      const sandbox={require:require('node:module').createRequire(file),module:{exports:{}},process};
      vm.runInNewContext(fs.readFileSync(file,'utf8') + \`
        let focused='entry', controls=[], injected=false;
        const regions=['review','user','entry'];
        borkLayoutScreenControl=function(context,args){
          if(args[0]==='-Q' && args[1]==='number') return focused+' title';
          controls.push(args);
          if(args[1]==='focus') focused=args[2]==='top' ? regions[0] : regions[(regions.indexOf(focused)+1)%regions.length];
          if(args[1]==='resize' && args[2]==='-h') { focused='user'; injected=true; }
          return '';
        };
        let blocked=false;
        try {
          borkLayoutScreenSize({context:{session:'fixture'},resources:{'review:1':{id:'review'}},plan:{slots:{'review:1':{width:40,height:10}}}});
        } catch(error) { blocked=error.message.includes('User navigated'); }
        if(!injected || !blocked || focused!=='user' || controls.some(args=>args[1]==='resize' && args[2]==='-v') || navigation.size!==0) throw Error('Resize navigation guard failed');
      \`,sandbox);
    `;
    const result = run([process.execPath, '-e', script, String(HELPER)], {capture_output: true, text: true});
    this.assertEqual(result.status, 0, result.stderr);
  }
  test_app_restore_uses_entry_focus_and_respects_navigation() {
    /* A public-control fixture restores only focus caused by the current operation. */
    const app = P(this.root).join('herdr-app');
    const state = P(this.root).join('focus.json');
    app.writeText('#!' + process.execPath + '\nconst fs=require("node:fs");const path=' + json(String(state)) + ';let focus=JSON.parse(fs.readFileSync(path,"utf8"));if(process.argv[2]==="do"){focus=JSON.parse(process.argv[4]).pane;fs.writeFileSync(path,JSON.stringify(focus));}console.log(JSON.stringify({focused_pane:focus}));\n');
    app.chmod(448);
    const code = 'const a=require(require("node:path").join(require("node:path").dirname(process.argv[1]),"layout-adapters/hc-app.js"));a.borkLayoutAppRestoreFocus({context:{},original:{focus:"creation"}},"entry","new");';
    for (const [current, expected] of [['new', 'entry'], ['navigation', 'navigation'], ['entry', 'entry']]) {
      state.writeText(json(current));
      const result = run([process.execPath, '-e', code, String(HELPER)], {env: {...process.env, PATH: String(this.root) + nodePath.delimiter + process.env.PATH}, capture_output: true, text: true});
      this.assertEqual(result.status, 0, result.stderr);
      this.assertEqual(JSON.parse(state.readText()), expected);
    }
  }
  test_real_geometry_focus_and_cleanup() {
    /* All three real tree sizes preserve unrelated panes and focus on cleanup. */
    for (var count of [1, 2, 3]) {
      var [data, record, unrelated] = this.create({
        "count": count
      });
      this.assertEqual(this.tmux("display-message", "-p", "-t", "fixture", "#{pane_id}"), data.coordinator);
      this.assertEqual(Object.keys(record.resources).length, count * 3 + 1);
      this.tmux("select-pane", "-t", count === 2 ? record.resources["fix:1"].id : unrelated);
      var cleanup = this.invoke("cleanup", {
        record: data.record,
        results_verified: true,
        descendants_stopped: true
      });
      this.assertTrue(cleanup.ok, cleanup);
      this.assertEqual(this.tmux("display-message", "-p", "-t", "fixture", "#{pane_id}"), count === 2 ? data.coordinator : unrelated);
      this.assertEqual(new Set(this.tmux("list-panes", "-t", "fixture", "-F", "#{pane_id}").trimEnd().split(/\r?\n/)), new Set([data.coordinator, unrelated]));
      this.tmux("kill-server");
      P(data.record).unlink();
    }
  }
  test_claim_release_turnover_and_duplicate_guard() {
    /* Cycles reuse placement while active or uncertain launches cannot duplicate it. */
    var [data, record, unrelated] = this.create();
    this.tmux("select-pane", "-t", record.resources["review:1"].id);
    var claim = {
      record: data.record,
      role: "review",
      slot: 1,
      target_id: "i1",
      task_id: "review-1"
    };
    var first = this.invoke("claim", claim);
    this.assertTrue(first.ok, first);
    this.assertFalse(this.invoke("claim", claim).ok);
    this.assertFalse(this.invoke("cleanup", {
      record: data.record,
      results_verified: true,
      descendants_stopped: true
    }).ok);
    var result_path = P(this.root).join("result.json");
    result_path.writeText(json({
      status: "complete"
    }));
    var release = {
      record: data.record,
      placement: "review:1",
      task_id: "review-1",
      result_path: String(result_path),
      results_verified: true,
      worker_stopped: true,
      descendants_stopped: true
    };
    this.tmux("select-pane", "-t", unrelated);
    this.assertTrue(this.invoke("release", release).ok);
    this.assertEqual(this.tmux("display-message", "-p", "-t", "fixture", "#{pane_id}"), unrelated);
    [claim.target_id, claim.task_id] = ["i2", "review-2"];
    var second = this.invoke("claim", claim);
    this.assertEqual(first.result.id, second.result.id);
    this.assertFalse(this.invoke("create", data).ok);
  }
  test_release_accepts_good_role_results_and_rejects_pending() {
    /* Real goodcode result statuses release both roles only after shutdown. */
    var [data, _, _] = this.create();
    var result_path = P(this.root).join("role-result.json");
    for (var role of ["review", "fix"]) {
      var task = role + "-1";
      var claim = {
        record: data.record,
        role: role,
        slot: 1,
        target_id: "i1",
        task_id: task
      };
      this.assertTrue(this.invoke("claim", claim).ok);
      var release = {
        record: data.record,
        placement: role + ":1",
        task_id: task,
        result_path: String(result_path),
        results_verified: true,
        worker_stopped: true,
        descendants_stopped: true
      };
      for (var status of ["pending", "", "coding"]) {
        result_path.writeText(json({
          role: role,
          task_id: task,
          status: status
        }));
        this.assertFalse(this.invoke("release", release).ok);
      }
      result_path.writeText(json({
        role: role,
        task_id: task,
        status: "good"
      }));
      this.assertFalse(this.invoke("release", {
        ...release,
        worker_stopped: false
      }).ok);
      this.assertTrue(this.invoke("release", release).ok);
    }
  }
  test_app_binding_uses_claimed_child_identity() {
    /* Bind the child run and task while rejecting unrelated terminal identities. */
    var hc = P(this.root).join("hc");
    var app = P(this.root).join("herdr-app");
    var terminal_path = P(this.root).join("terminal.json");
    var doc = {
      value: {
        spaces: [{
          id: "s1",
          tabs: [{
            id: "tab1",
            root: {
              type: "row",
              id: "root",
              children: [{
                type: "block",
                id: "coord",
                content: {
                  terminal: "t1"
                }
              }, {
                type: "block",
                id: "review",
                content: {
                  terminal: "t2"
                }
              }]
            }
          }]
        }]
      },
      version: 1
    };
    hc.writeText('#!' + process.execPath + '\nconst fs=require("node:fs");const r=JSON.parse(fs.readFileSync(0,"utf8"));const doc=' + json(doc) + ';const terminal=JSON.parse(fs.readFileSync(' + json(String(terminal_path)) + ',"utf8"));const v={"server.status":{core:{id:"core1"}},"doc.get":doc,"terminal.get":terminal}[r.method];console.log(JSON.stringify({result:v}));\n');
    app.writeText('#!' + process.execPath + '\nconsole.log(JSON.stringify({space:"s1",tab:"tab1",focused_pane:"coord",overlays:[],errors:[]}));\n');
    hc.chmod(448);
    app.chmod(448);
    var terminal = {
      address: "child-terminal",
      cols: 50,
      rows: 40,
      created_ms: 42,
      labels: {
        "bork-run": "child",
        "bork-task": "review-1"
      }
    };
    var record = {
      driver: "hc",
      state: "ready",
      run_id: "batch",
      coordinator: "coord",
      context: {
        core_id: "core1",
        root_area: {
          x: 0,
          y: 0,
          width: 101,
          height: 40
        }
      },
      original: {
        focus: "coord",
        panes: {
          coord: {
            window: "tab1",
            x: 0,
            y: 0,
            width: 50,
            height: 40
          }
        }
      },
      plan: {
        slots: {
          coordinator: {
            x: 0,
            y: 0,
            width: 50,
            height: 40
          },
          "review:1": {
            x: 51,
            y: 0,
            width: 50,
            height: 40
          }
        }
      },
      resources: {
        coordinator: {
          id: "coord"
        },
        "review:1": {
          id: "review",
          state: "claimed",
          run_id: "child",
          task_id: "review-1"
        }
      }
    };
    var path = P(this.root).join("app-layout.json");
    path.writeText(json(record));
    var request = {
      record: String(path),
      placement: "review:1",
      task_id: "review-1",
      run_id: "child",
      terminal_id: "child-terminal",
      created_ms: 42
    };
    var env = {
      ...process.env,
      PATH: String(this.root) + nodePath.delimiter + process.env.PATH
    };
    const bind = (data, identity) => {
      /* Call the production binding with a controlled core response. */
      terminal_path.writeText(json(identity));
      this.index += 1;
      var request_path = P(this.root).join("bind-" + String(this.index) + ".json");
      request_path.writeText(json(data));
      var proc = run([process.execPath, String(HELPER), "bind", String(request_path)], {
        "env": env,
        "capture_output": true,
        "text": true,
        "timeout": 15
      });
      return JSON.parse(proc.stdout);
    };
    for (var change of [{
      address: "other"
    }, {
      created_ms: 43
    }, {
      labels: {
        "bork-run": "other",
        "bork-task": "review-1"
      }
    }, {
      labels: {
        "bork-run": "child",
        "bork-task": "other"
      }
    }]) {
      this.assertFalse(bind(request, {
        ...terminal,
        ...change
      }).ok);
    }
    this.assertFalse(bind({
      ...request,
      run_id: "other"
    }, terminal).ok);
    this.assertFalse(bind({
      ...request,
      task_id: "other"
    }, terminal).ok);
    this.assertTrue(bind(request, terminal).ok);
  }
  test_resize_and_uncertain_split_block_claim() {
    /* Geometry drift and pending journal intents pause new worker assignment. */
    var [data, record, _] = this.create();
    var request = {
      record: data.record,
      role: "master",
      slot: 1,
      target_id: "i1",
      task_id: "master-1"
    };
    this.tmux("resize-pane", "-t", record.resources["review:1"].id, "-L", "3");
    this.assertFalse(this.invoke("claim", request).ok);
    record.pending = {
      operation: "split",
      before: {}
    };
    P(data.record).writeText(json(record));
    this.assertFalse(this.invoke("claim", request).ok);
    this.assertTrue(this.invoke("inspect", {
      record: data.record
    }).ok);
  }
  test_occupied_placeholder_is_preserved() {
    /* A foreign process in an idle slot blocks reassignment and cleanup. */
    var [data, record, _] = this.create();
    var pane = record.resources["review:1"].id;
    this.tmux("respawn-pane", "-k", "-t", pane, "sleep 60");
    var request = {
      record: data.record,
      role: "review",
      slot: 1,
      target_id: "i1",
      task_id: "review-1"
    };
    this.assertFalse(this.invoke("claim", request).ok);
    this.assertFalse(this.invoke("cleanup", {
      record: data.record,
      results_verified: true,
      descendants_stopped: true
    }).ok);
    this.assertIn(pane, this.tmux("list-panes", "-t", "fixture", "-F", "#{pane_id}").trimEnd().split(/\r?\n/));
  }
  test_launcher_uses_recorded_role_pane() {
    /* An integrated launch stays in its assigned pane and existing window. */
    var [data, record, _] = this.create();
    var job = P(this.root).join("job.json");
    job.writeText(json({
      argv: [process.execPath, "-e", "console.log(\"layout worker\");"],
      exit_record: String(P(this.root).join("exit.json"))
    }));
    var launch = {
      role: "master",
      cwd: String(this.root),
      job: String(job),
      session_name: "unused-legacy-name",
      socket: this.socket,
      layout_record: data.record,
      slot: 1,
      task_id: "master-1",
      target_id: "i1"
    };
    var result = this.invoke("launch", launch, {
      "helper": TMUX
    });
    this.assertTrue(result.ok, result);
    this.assertEqual(result.result.pane, record.resources["master:1"].id);
    this.assertEqual(this.tmux("list-sessions", "-F", "#{session_name}"), "fixture");
    this.assertEqual(this.tmux("show-options", "-Awv", "-t", "fixture", "pane-border-status"), "off");
    this.assertTrue(this.invoke("claim", {
      record: data.record,
      role: "review",
      slot: 1,
      target_id: "i1",
      task_id: "review-1"
    }).ok);
  }
}
if (require.main === module) suite(LayoutTests, {
  "test_real_geometry_focus_and_cleanup": !which("tmux") ? "tmux unavailable" : false,
  "test_claim_release_turnover_and_duplicate_guard": !which("tmux") ? "tmux unavailable" : false,
  "test_release_accepts_good_role_results_and_rejects_pending": !which("tmux") ? "tmux unavailable" : false,
  "test_resize_and_uncertain_split_block_claim": !which("tmux") ? "tmux unavailable" : false,
  "test_occupied_placeholder_is_preserved": !which("tmux") ? "tmux unavailable" : false,
  "test_launcher_uses_recorded_role_pane": !which("tmux") ? "tmux unavailable" : false
});
module.exports = {
  LayoutTests
};
