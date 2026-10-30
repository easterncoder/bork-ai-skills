'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const demand = require('../layout-demand.js');
const host = require('../layout-demand-host.js');
const helper = path.resolve(__dirname, '../layout.js');

/** Allocate only private tmux resources and remove them even on failed assertions. */
function fixture(width, height, callback) {
  const directory = fs.mkdtempSync('/tmp/bork-demand-test-');
  const socket = path.basename(directory);
  /** Address this test's isolated server. */
  function tmux(...args) { return cp.execFileSync('tmux', ['-L', socket, ...args], {encoding: 'utf8'}).trim(); }
  let sequence = 0;
  /** Exercise the serialized public CLI instead of bypassing journal ownership. */
  function action(name, input = {}, success = true) {
    const file = path.join(directory, `${++sequence}.json`);
    fs.writeFileSync(file, JSON.stringify({record: path.join(directory, 'layout.json'), ...input}));
    const process = cp.spawnSync(global.process.execPath, [helper, name, file], {encoding: 'utf8'});
    const response = JSON.parse(process.stdout);
    assert.equal(response.ok, success, response.error);
    return response.result ?? response;
  }
  /** Stop only the fixture server after synchronous or asynchronous assertions. */
  function cleanup() { try { tmux('kill-server'); } finally { fs.rmSync(directory, {recursive: true}); } }
  try {
    const coordinator = tmux('new-session', '-d', '-P', '-F', '#{pane_id}', '-x', String(width), '-y', String(height));
    const result = callback({directory, tmux, action, coordinator, record: path.join(directory, 'layout.json'), context: {socket}});
    if (result?.then) return result.finally(cleanup);
    cleanup();
    return result;
  } catch (error) { cleanup(); throw error; }
}

/** Form an explicit imminent worker identity. */
function identity(role, slot, pass = 1) { return {role, slot, target_id: `target-${slot}`, task_id: `${role}-${slot}-${pass}`}; }

/** Require real stopped shells and accepted durable results before physical removal. */
function release(f, role, slot, pass = 1) {
  const result = path.join(f.directory, 'result.json');
  fs.writeFileSync(result, JSON.stringify({status: 'complete'}));
  return f.action('release', {placement: `${role}:${slot}`, task_id: identity(role, slot, pass).task_id, result_path: result, results_verified: true, worker_stopped: true, descendants_stopped: true});
}

/** Verify actual topology demand independently from the concurrency ceiling. */
test('demand planner allocates actual roles, stable slots and both creation orders', () => {
  const area = {x: 5, y: 7, width: 200, height: 80};
  assert.deepEqual(Object.keys(demand.demandPlan(3, area).slots), ['coordinator']);
  for (const roles of [['master', 'review', 'fix'], ['master', 'fix', 'review']]) {
    const plan = demand.demandPlan(3, area, {3: roles, 1: ['master']});
    assert.equal(plan.slots['master:1'].y, area.y);
    assert.ok(plan.slots['master:3'].y > plan.slots['master:1'].y);
    assert.equal(plan.slots['review:3'].x, plan.slots['fix:3'].x);
    assert.ok(plan.slots['fix:3'].y > plan.slots['review:3'].y);
    assert.equal(plan.slots['master:1'].width, area.width - plan.slots.coordinator.width - 1);
  }
  assert.throws(() => demand.demandPlan(3, {x: 0, y: 0, width: 60, height: 60}, {1: ['master']}, 1, true), /actual 60x60/);
});

/** Exercise all live shapes while protecting foreign geometry and every surviving PID. */
test('private tmux demand lifecycle supports turnover, repeated passes and arbitrary group finish', {skip: cp.spawnSync('tmux', ['-V']).status !== 0}, () => {
  fixture(260, 90, f => {
    const foreign = f.tmux('split-window', '-d', '-h', '-l', '20', '-P', '-F', '#{pane_id}', '-t', f.coordinator);
    const created = f.action('create', {driver: 'tmux', context: f.context, coordinator: f.coordinator, concurrency: 3, cwd: f.directory, run_id: 'demand-test'});
    assert.equal(created.version, 2);
    assert.equal(Object.keys(created.resources).length, 1);
    f.tmux('select-pane', '-t', foreign);
    const original = f.action('inspect').snapshot.panes[foreign];
    const pids = new Map();
    for (const slot of [3, 1, 2]) for (const role of ['master', ...(slot === 1 ? ['review', 'fix'] : ['fix', 'review'])]) {
      const resource = f.action('claim', identity(role, slot));
      const snapshot = f.action('inspect').snapshot;
      pids.set(resource.id, snapshot.panes[resource.id].pid);
      assert.deepEqual(snapshot.panes[foreign], original);
      assert.equal(snapshot.focus, foreign);
      for (const [id, pid] of pids) assert.equal(snapshot.panes[id].pid, pid);
    }
    release(f, 'review', 1); pids.delete(created.resources['review:1']?.id);
    const repeated = f.action('claim', identity('review', 1, 2));
    assert.ok(repeated.id);
    for (const slot of [2, 1, 3]) for (const role of ['review', 'fix', 'master']) release(f, role, slot, slot === 1 && role === 'review' ? 2 : 1);
    const final = f.action('inspect');
    assert.equal(Object.keys(final.record.resources).length, 1);
    assert.deepEqual(final.snapshot.panes[foreign], original);
    assert.equal(final.snapshot.focus, foreign);
    f.action('cleanup', {results_verified: true, descendants_stopped: true});
  });
});

/** Reserve headroom without opening placeholders and wake capacity after release. */
test('private tmux admission queues capacity without deadlocking review/fix', {skip: cp.spawnSync('tmux', ['-V']).status !== 0}, () => {
  fixture(120, 22, f => {
    f.action('create', {driver: 'tmux', context: f.context, coordinator: f.coordinator, concurrency: 3, cwd: f.directory, run_id: 'capacity-test'});
    assert.equal(f.action('admit', {target_id: 'target-1', slot: 1}).admitted, true);
    const waiting = f.action('admit', {target_id: 'target-2', slot: 2});
    assert.equal(waiting.status, 'waiting_capacity');
    for (const role of ['master', 'review', 'fix']) f.action('claim', identity(role, 1));
    for (const role of ['review', 'fix', 'master']) release(f, role, 1);
    const next = f.action('admit', {target_id: 'target-2', slot: 2});
    assert.equal(next.admitted, true);
    assert.ok(next.generation > waiting.generation);
    f.action('cancel-admission', {target_id: 'target-2', master_stopped: true, descendants_stopped: true});
  });
  fixture(70, 15, f => {
    f.action('create', {driver: 'tmux', context: f.context, coordinator: f.coordinator, concurrency: 3, cwd: f.directory, run_id: 'tiny-test'});
    assert.equal(f.action('admit', {target_id: 'target-1'}).status, 'blocked');
    assert.equal(f.tmux('list-panes', '-F', '#{pane_id}'), f.coordinator);
  });
});

/** Recover a saved returned ID in a new helper without splitting another worker. */
test('private tmux reflow failure survives helper restart with exact retained identities', {skip: cp.spawnSync('tmux', ['-V']).status !== 0}, () => {
  fixture(150, 40, f => {
    const record = f.action('create', {driver: 'tmux', context: f.context, coordinator: f.coordinator, concurrency: 1, cwd: f.directory, run_id: 'recovery-test'});
    const original = host.reflow;
    host.reflow = () => { throw new Error('simulated helper interruption after durable split identity'); };
    try { assert.throws(() => demand.claim({record: f.record, ...identity('master', 1)}, record), /simulated helper interruption/); }
    finally { host.reflow = original; }
    const interrupted = JSON.parse(fs.readFileSync(f.record));
    const id = interrupted.pending.returned_id;
    assert.ok(id);
    const pid = f.action('inspect').snapshot.panes[id].pid;
    f.action('claim', identity('master', 1), false);
    f.action('reconcile');
    const recovered = f.action('inspect');
    assert.equal(recovered.record.resources['master:1'].id, id);
    assert.equal(recovered.snapshot.panes[id].pid, pid);
    assert.equal(Object.keys(recovered.snapshot.panes).length, 2);
    release(f, 'master', 1);
  });
});

/** Couple queue reservation to measured admission, retaining queued targets until wake. */
test('batch reservations honor pair headroom and wake queued targets after cancellation', {skip: cp.spawnSync('tmux', ['-V']).status !== 0}, () => {
  fixture(120, 22, f => {
    f.action('create', {driver: 'tmux', context: f.context, coordinator: f.coordinator, concurrency: 3, cwd: f.directory, run_id: 'batch-capacity'});
    const planPath = path.join(f.directory, 'plan.json'), preview = 'three targets', crypto = require('node:crypto');
    let revision = 0;
    /** Execute serialized batch transitions against this private layout. */
    function batch(action, extra = {}) {
      const file = path.join(f.directory, 'batch-input.json');
      fs.writeFileSync(file, JSON.stringify({action, plan_path: planPath, expected_revision: revision, ...extra}));
      const child = cp.spawnSync(process.execPath, [path.resolve(__dirname, '../batch.js'), file], {encoding: 'utf8'});
      const response = JSON.parse(child.stdout); assert.equal(response.ok, true, response.error); if(Object.hasOwn(response.result,'state_revision'))revision=response.result.state_revision; return response.result;
    }
    batch('init', {plan: {schema_version: 5, batch_id: 'capacity', approved_preview: preview, approval_evidence: {response: 'go', preview_sha256: crypto.createHash('sha256').update(preview).digest('hex')}, max_concurrency: 3, merge_enabled: false, reviewer: 'NONE', layout_record: f.record, targets: {'1': {status: 'queued', depends_on: []}, '2': {status: 'queued', depends_on: []}, '3': {status: 'queued', depends_on: []}}}});
    const first = batch('reserve'); assert.deepEqual(first.launch, ['1']); assert.equal(first.waiting_capacity['2'].status, 'waiting_capacity');
    const saved = JSON.parse(fs.readFileSync(planPath)); assert.equal(saved.targets['2'].status, 'queued');
    f.action('cancel-admission', {target_id: '1', master_stopped: true, descendants_stopped: true});
    const second = batch('reserve'); assert.deepEqual(second.launch, ['2']); assert.ok(second.waiting_capacity['3']);
    f.action('cancel-admission', {target_id: '2', master_stopped: true, descendants_stopped: true});
  });
});

/** Race actual independent helpers against the same journal and retain exact role ownership. */
test('concurrent review and fix claims serialize without duplicate workers', {skip: cp.spawnSync('tmux', ['-V']).status !== 0}, async () => {
  await fixture(150, 35, async f => {
    f.action('create', {driver: 'tmux', context: f.context, coordinator: f.coordinator, concurrency: 3, cwd: f.directory, run_id: 'concurrent-demand'});
    f.action('claim', identity('master', 1));
    /** Execute one claim in a genuinely independent helper process. */
    function claim(role) {
      const input = path.join(f.directory, role+'.json'); fs.writeFileSync(input, JSON.stringify({record: f.record, ...identity(role, 1)}));
      return new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, [helper, 'claim', input]); let output = '', errors = '';
        child.stdout.on('data', data => {output += data;}); child.stderr.on('data', data => {errors += data;}); child.on('error', reject);
        child.on('close', code => {try {assert.equal(code, 0, output+errors); resolve(JSON.parse(output).result);} catch(error) {reject(error);} });
      });
    }
    const [review, fix] = await Promise.all([claim('review'), claim('fix')]);
    assert.notEqual(review.id, fix.id); const state = f.action('inspect'); assert.equal(Object.keys(state.snapshot.panes).length, 4);
    assert.ok(state.snapshot.panes[review.id].y < state.snapshot.panes[fix.id].y);
    assert.equal(state.record.resources['review:1'].task_id, 'review-1-1');
    release(f, 'fix', 1); release(f, 'review', 1); release(f, 'master', 1);
  });
});

/** Verify the launch consumer uses its newly claimed role and retains stopped output. */
test('tmux launch consumer claims imminent demand role and releases its stopped runner', {skip: cp.spawnSync('tmux', ['-V']).status !== 0}, () => {
  fixture(130, 30, f => {
    f.action('create', {driver: 'tmux', context: f.context, coordinator: f.coordinator, concurrency: 3, cwd: f.directory, run_id: 'demand-launch'});
    const job = path.join(f.directory, 'job.json'), exit = path.join(f.directory, 'exit.json'), input = path.join(f.directory, 'launch.json');
    fs.writeFileSync(job, JSON.stringify({argv: [process.execPath, '-e', 'console.log("retained demand output");setTimeout(()=>{},100)'], exit_record: exit}));
    fs.writeFileSync(input, JSON.stringify({...f.context, cwd: f.directory, job, session_name: 'imminent', layout_record: f.record, ...identity('master', 1)}));
    const launch = cp.spawnSync(process.execPath, [path.resolve(__dirname, '../tmux.js'), 'launch', input], {encoding: 'utf8'});
    assert.equal(launch.status, 0, launch.stdout+launch.stderr);
    for (let count = 0; count < 100 && !fs.existsSync(exit); count++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    assert.ok(fs.existsSync(exit)); assert.equal(JSON.parse(fs.readFileSync(exit)).exit_code, 0);
    const pane = JSON.parse(launch.stdout).result.pane;
    const output = f.tmux('capture-pane', '-p', '-S', '-', '-t', pane); assert.match(output, /retained demand output/);
    fs.writeFileSync(path.join(f.directory, 'output.txt'), output);
    assert.equal(Object.keys(f.action('inspect').snapshot.panes).length, 2);
    release(f, 'master', 1); assert.equal(Object.keys(f.action('inspect').snapshot.panes).length, 1);
  });
});

/** Stop mutations on unverified user edits and unknown journal versions without losing workers. */
test('demand launch guards preserve live occupants after user resize or foreign edits', {skip: cp.spawnSync('tmux', ['-V']).status !== 0}, () => {
  fixture(150, 35, f => {
    f.action('create', {driver: 'tmux', context: f.context, coordinator: f.coordinator, concurrency: 3, cwd: f.directory, run_id: 'demand-guards'});
    const master = f.action('claim', identity('master', 1));
    const pid = f.action('inspect').snapshot.panes[master.id].pid;
    f.tmux('resize-pane', '-t', f.coordinator, '-x', '40');
    f.action('claim', identity('review', 1), false);
    assert.equal(Object.keys(f.action('inspect').snapshot.panes).length, 2);
    assert.equal(f.action('inspect').snapshot.panes[master.id].pid, pid);
    const foreign = f.tmux('split-window', '-d', '-t', master.id, '-P', '-F', '#{pane_id}');
    f.action('claim', identity('fix', 1), false);
    assert.ok(f.action('inspect').snapshot.panes[foreign]);
    const journal = JSON.parse(fs.readFileSync(f.record)); journal.version = 99; fs.writeFileSync(f.record, JSON.stringify(journal));
    assert.match(f.action('claim', identity('fix', 1), false).error, /Unsupported layout journal version/);
    assert.equal(f.tmux('display-message', '-p', '-t', master.id, '#{pane_pid}'), String(pid));
  });
});
