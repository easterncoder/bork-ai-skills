'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const layout = require('../layout.js');
const demand = require('../layout-demand.js');

/** Exercise real journal verification with only the host transport replaced. */
function fixture(driver, version, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bork-resize-'));
  const area = {x: 0, y: 0, width: 180, height: 50};
  const topology = {1: ['master', 'review', 'fix']};
  const plan = demand.demandPlan(1, area, topology, driver === 'herdr' ? 0 : 1);
  const resources = Object.fromEntries(Object.keys(plan.slots).map(key => [key, {id: key, terminal: key, shell_pid: 10, actual_cells: [plan.slots[key].width, plan.slots[key].height]}]));
  const record = {record: path.join(directory, 'layout.json'), driver, version, lifecycle: 'demand', state: 'ready', coordinator: 'coordinator', run_id: 'resize-test', context: {}, resources, plan, original: {panes: {coordinator: {...area, id: 'coordinator', window: 'window', session: 'session'}}}, generation: 0, capacity_generation: 0, capacity_waiters: {}, admissions: {1: {target_id: 'target-1'}}};
  /** Supply measured geometry and identities using the production adapter's normalized shape. */
  function snapshot(width, height) {
    const next = demand.demandPlan(1, {...area, width, height}, topology, driver === 'herdr' ? 0 : 1);
    return {panes: Object.fromEntries(Object.entries(next.slots).map(([key, rect]) => [key, {...rect, id: key, window: 'window', session: 'session', terminal: key, owner: 'resize-test', placement: key, cols: rect.width, rows: rect.height}])), focus: 'coordinator', root_area: {...area, width, height}};
  }
  const adapters = {tmux: ['tmux', 'borkLayoutTmuxSnapshot'], herdr: ['herdr', 'borkLayoutHerdrSnapshot'], screen: ['screen', 'borkLayoutScreenSnapshot'], hc: ['hc-app', 'borkLayoutAppSnapshot']};
  const [file, method] = adapters[driver], adapter = require(`../layout-adapters/${file}.js`);
  let current = snapshot(180, 50);
  const original = adapter[method], herdr = adapter.borkLayoutHerdr;
  const calls = [];
  adapter[method] = context => {calls.push(context); return structuredClone(current);};
  if (driver === 'herdr') adapter.borkLayoutHerdr = () => ({process_info: {shell_pid: 10}});
  fs.writeFileSync(record.record, JSON.stringify(record));
  try { callback({record, snapshot, calls, set: value => {current = value;}, verify: () => version === 2 ? demand.verify(record) : layout.borkLayoutVerify(record)}); }
  finally { adapter[method] = original; if (herdr) adapter.borkLayoutHerdr = herdr; fs.rmSync(directory, {recursive: true}); }
}

for (const driver of ['herdr', 'tmux', 'screen', 'hc']) for (const version of [1, 2]) {
  test(`${driver} v${version} adopts larger and smaller stable layouts`, () => fixture(driver, version, f => {
    for (const [width, height] of [[240, 70], [150, 40]]) {
      const live = f.snapshot(width, height);
      f.set(live);
      assert.deepEqual(f.verify().panes, live.panes);
      assert.equal(f.record.plan.area.width, width);
      assert.equal(JSON.parse(fs.readFileSync(f.record.record)).plan.area.height, height);
    }
  }));
  test(`${driver} v${version} rejects reordered or missing panes without adopting them`, () => fixture(driver, version, f => {
    const saved = fs.readFileSync(f.record.record, 'utf8');
    const live = f.snapshot(240, 70);
    [live.panes['review:1'].y, live.panes['fix:1'].y] = [live.panes['fix:1'].y, live.panes['review:1'].y];
    f.set(live);
    assert.throws(f.verify, /topology|geometry/);
    assert.equal(fs.readFileSync(f.record.record, 'utf8'), saved);
    delete live.panes['fix:1'];
    assert.throws(f.verify, /missing|identity/);
    assert.equal(fs.readFileSync(f.record.record, 'utf8'), saved);
  }));
}

test('resized reservations recheck pair capacity before launch', () => fixture('tmux', 2, f => {
  f.set(f.snapshot(180, 50));
  const narrow = f.snapshot(150, 40);
  for (const pane of Object.values(narrow.panes)) { pane.x = Math.floor(pane.x / 2); pane.width = Math.floor(pane.width / 2); }
  f.set(narrow);
  const result = demand.admission(f.record, {target_id: 'target-1', slot: 1});
  assert.equal(result.admitted, false);
  assert.equal(result.status, 'blocked');
  assert.ok(result.actual.width < result.required.width);
}));


for (const version of [1, 2]) test(`App v${version} refreshes cached root capacity after font changes`, () => fixture('hc', version, f => {
  const live = f.snapshot(180, 50);
  for (const pane of Object.values(live.panes)) pane.cols += 5;
  f.set(live);
  f.verify();
  assert.ok(f.calls.some(context => context.root_area === null));
  assert.deepEqual(f.record.resources['review:1'].actual_cells, [live.panes['review:1'].cols, live.panes['review:1'].rows]);
}));

for (const version of [1, 2]) test(`tmux v${version} preserves pending operations and ownership guards during resize`, () => fixture('tmux', version, f => {
  f.set(f.snapshot(240, 70));
  f.record.pending = {kind: 'split', checkpoint: {retained: true}};
  const pending = structuredClone(f.record.pending);
  assert.throws(f.verify, /Uncertain/);
  assert.deepEqual(f.record.pending, pending);
  f.record.pending = null;
  const live = f.snapshot(240, 70);
  live.panes['review:1'].owner = 'foreign';
  f.set(live);
  assert.throws(f.verify, /ownership/);
  assert.equal(JSON.parse(fs.readFileSync(f.record.record)).plan.area.width, 180);
}));

/** Detect font changes even before the first App worker has been created. */
test('empty App journals record coordinator cells and refresh first-launch capacity', () => fixture('hc', 2, f => {
  const pane = {id: 'coordinator', x: 0, y: 0, width: 180, height: 50, cols: 180, rows: 50, window: 'window', session: 'session', terminal: 'coordinator'};
  const live = {panes: {coordinator: pane}, focus: 'coordinator', tree: {core_id: 'test-core'}, root_area: {x: 0, y: 0, width: 180, height: 50}};
  f.set(live);
  const created = demand.create({record: f.record.record, driver: 'hc', coordinator: 'coordinator', concurrency: 1, run_id: 'empty-app'}, {context: {}, capability: {}, snapshot: live});
  assert.deepEqual(created.resources.coordinator.actual_cells, [180, 50]);
  f.set({...live, panes: {coordinator: {...pane, width: 220, cols: 220}}, root_area: {...live.root_area, width: 220}});
  demand.verify(created);
  assert.equal(created.plan.area.width, 220);
  assert.ok(f.calls.some(context => context.root_area === null));
}));
