'use strict';

const fs = require('node:fs');
const {borkLayoutGeometry} = require('./layout-plan.js');

/** Validate a demand topology and return compact active slot/role groups. */
function groupsFor(topology, concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('Layout concurrency must be 1, 2 or 3.');
  const groups = [];
  for (const [slotText, roles] of Object.entries(topology)) {
    const slot = Number(slotText);
    if (!Number.isInteger(slot) || String(slot) !== slotText || slot < 1 || slot > concurrency || !Array.isArray(roles) || new Set(roles).size !== roles.length || !roles.includes('master') || roles.some(role => !['master', 'review', 'fix'].includes(role))) {
      throw new Error('Demand topology requires unique roles and a master in each stable slot.');
    }
    groups.push({slot, roles});
  }
  return groups.sort((a, b) => a.slot - b.slot);
}

/** Plan only active/requested roles, retaining logical headroom for both tandem roles. */
function demandPlan(concurrency, area, topology = {}, gap = 1, reservePair = false, minimum = {width: 35, height: 6}) {
  area = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, area[key]]));
  const groups = groupsFor(topology, concurrency);
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!Number.isInteger(area[key]) || area[key] < (key === 'width' || key === 'height' ? 1 : 0)) throw new Error('Layout needs verified integer pane geometry.');
  }
  if (![0, 1].includes(gap)) throw new Error('Invalid separator width.');
  const slots = {coordinator: {...area}};
  if (!groups.length) return {version: 2, concurrency, area, separator: gap, topology, slots, operations: []};
  const left = Math.max(20, Math.floor((area.width - 2 * gap) * .22));
  const width = area.width - left - gap;
  const row = Math.floor((area.height - (groups.length - 1) * gap) / groups.length);
  const pair = groups.some(group => reservePair || group.roles.length > 1);
  const required = {width: left + gap + (pair ? 2 * minimum.width + gap : minimum.width), height: groups.length * (reservePair || groups.some(group => group.roles.length === 3) ? 2 * minimum.height + gap : minimum.height) + (groups.length - 1) * gap};
  if (area.width < required.width || area.height < required.height) {
    const error = new Error(`Insufficient demand layout capacity: actual ${area.width}x${area.height}, required ${required.width}x${required.height} for ${groups.length} active target group(s)${reservePair ? ' with concurrent review/fix headroom' : ''}.`);
    error.code = 'layout_capacity';
    error.actual = {width: area.width, height: area.height};
    error.required = required;
    throw error;
  }
  slots.coordinator.width = left;
  let y = area.y;
  for (const [index, group] of groups.entries()) {
    const height = index === groups.length - 1 ? area.y + area.height - y : row;
    const x = area.x + left + gap;
    const key = `master:${group.slot}`;
    slots[key] = {x, y, width, height};
    const roles = ['review', 'fix'].filter(role => group.roles.includes(role));
    if (roles.length) {
      const masterWidth = Math.floor((width - gap) / 2);
      slots[key].width = masterWidth;
      const roleWidth = width - masterWidth - gap;
      let roleY = y;
      for (const [roleIndex, role] of roles.entries()) {
        const roleHeight = roles.length === 1 ? height : roleIndex === 0 ? Math.floor((height - gap) / 2) : height - Math.floor((height - gap) / 2) - gap;
        slots[`${role}:${group.slot}`] = {x: x + masterWidth + gap, y: roleY, width: roleWidth, height: roleHeight};
        roleY += roleHeight + gap;
      }
    }
    y += height + gap;
  }
  return {version: 2, concurrency, area, separator: gap, topology, slots, operations: []};
}

/** Derive the role topology from journal identity rather than current focus. */
function topologyFor(resources) {
  const topology = {};
  for (const key of Object.keys(resources)) {
    if (key === 'coordinator') continue;
    const [role, slot] = key.split(':');
    (topology[slot] ??= []).push(role);
  }
  return topology;
}

/** Read a tmux tree while retaining all foreign pane IDs and rectangles. */
function parseTree(text) {
  let offset = text.indexOf(',') + 1;
  /** Consume a measured tmux node and its nested orientation. */
  function node() {
    const match = /^(\d+)x(\d+),(\d+),(\d+)(?:,(\d+))?/.exec(text.slice(offset));
    if (!match) throw new Error('Unrecognized tmux layout tree.');
    offset += match[0].length;
    const value = {width: +match[1], height: +match[2], x: +match[3], y: +match[4]};
    if (match[5] !== undefined) value.id = `%${match[5]}`;
    else {
      const open = text[offset++];
      if (!['{', '['].includes(open)) throw new Error('Missing tmux split orientation.');
      value.axis = open === '{' ? 'row' : 'column';
      value.children = [];
      do {
        value.children.push(node());
        if (text[offset] !== ',') break;
        offset++;
      } while (true);
      if (text[offset++] !== (open === '{' ? '}' : ']')) throw new Error('Unclosed tmux split.');
    }
    return value;
  }
  const root = node();
  if (offset !== text.length) throw new Error('Trailing tmux layout content.');
  return root;
}

/** Serialize a tmux layout with its required 16-bit checksum. */
function formatTree(root) {
  /** Encode one explicit rectangle, preserving stable pane identity. */
  function encode(node) {
    const base = `${node.width}x${node.height},${node.x},${node.y}`;
    if (node.id) return `${base},${node.id.slice(1)}`;
    const [open, close] = node.axis === 'row' ? ['{', '}'] : ['[', ']'];
    return base + open + node.children.map(encode).join(',') + close;
  }
  const body = encode(root);
  let checksum = 0;
  for (const value of Buffer.from(body)) checksum = (((checksum >> 1) | ((checksum & 1) << 15)) + value) & 0xffff;
  return checksum.toString(16).padStart(4, '0') + ',' + body;
}

/** Return the stable leaf identities in a tmux subtree. */
function leafIds(node) {
  return node.id ? [node.id] : node.children.flatMap(leafIds);
}

/** Construct the requested coordinator/group/role split tree. */
function ownedTree(plan, resources) {
  /** Attach a journaled pane to its exact planned rectangle. */
  function leaf(key) { return {...plan.slots[key], id: resources[key].id}; }
  /** Wrap leaves without changing their geometry or process identities. */
  function container(axis, children) {
    if (children.length === 1) return children[0];
    const x = Math.min(...children.map(child => child.x));
    const y = Math.min(...children.map(child => child.y));
    return {x, y, width: Math.max(...children.map(child => child.x + child.width)) - x, height: Math.max(...children.map(child => child.y + child.height)) - y, axis, children};
  }
  const groups = groupsFor(plan.topology, plan.concurrency).map(group => {
    const roles = ['review', 'fix'].filter(role => group.roles.includes(role)).map(role => leaf(`${role}:${group.slot}`));
    return container('row', [leaf(`master:${group.slot}`), ...(roles.length ? [container('column', roles)] : [])]);
  });
  return container('row', [leaf('coordinator'), ...(groups.length ? [container('column', groups)] : [])]);
}

/** Persist one journal revision using the shared atomic writer. */
function save(record) { require('./layout.js').borkLayoutWrite(record.record, record); }

/** Retain stable pane geometry and identity without transient shell state. */
function checkpoint(record) {
  if (record.driver === 'herdr') {
    const adapter = require('./layout-adapters/herdr.js');
    const snapshot = adapter.borkLayoutHerdr(record.context, ['api', 'snapshot']).snapshot;
    const layouts = snapshot.layouts.map(layout => ({tab_id: layout.tab_id, workspace_id: layout.workspace_id, area: layout.area, panes: layout.panes.map(pane => ({pane_id: pane.pane_id, rect: pane.rect})).sort((a, b) => a.pane_id.localeCompare(b.pane_id))})).sort((a, b) => a.tab_id.localeCompare(b.tab_id));
    const terminals = snapshot.panes.map(pane => ({id: pane.pane_id, tab: pane.tab_id, terminal: pane.terminal_id})).sort((a, b) => a.id.localeCompare(b.id));
    const identities = Object.values(record.resources).map(resource => resource.id);
    if (record.pending?.returned_id && !identities.includes(record.pending.returned_id)) identities.push(record.pending.returned_id);
    const live = new Set(snapshot.panes.map(pane => pane.pane_id));
    const shells = Object.fromEntries(identities.filter(id => live.has(id)).sort().map(id => [id, adapter.borkLayoutHerdr(record.context, ['pane', 'process-info', '--pane', id]).process_info.shell_pid]));
    return {layouts, terminals, shells};
  }
  const panes = require('./layout.js').borkLayoutSnapshot(record).panes;
  const geometry = Object.fromEntries(Object.entries(panes).sort(([a], [b]) => a.localeCompare(b)).map(([id, pane]) => [id, Object.fromEntries(['id', 'window', 'session', 'x', 'y', 'width', 'height', 'pid', 'owner', 'placement', 'terminal', 'created_ms'].filter(key => pane[key] !== undefined).map(key => [key, pane[key]]))]));
  if (record.driver !== 'screen') return geometry;
  const windows = require('./layout-adapters/screen.js').borkLayoutScreen(record.context, ['-Q', 'windows', '%n|%f;']).split(';').map(entry => entry.trim().split('|')[0]).filter(Boolean).sort();
  const owned = Object.entries(record.resources).filter(([key, resource]) => key !== 'coordinator' && windows.includes(resource.id));
  if (record.pending?.returned_id && !owned.some(([, resource]) => resource.id === record.pending.returned_id) && windows.includes(record.pending.returned_id)) owned.push([record.pending.key, {id: record.pending.returned_id}]);
  const processes = Object.fromEntries(owned.sort(([a], [b]) => a.localeCompare(b)).map(([key, resource]) => {
    const pid = Number(fs.readFileSync(`${record.record}.${key.replace(':', '-')}.pid`, 'utf8').trim());
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Screen worker process identity is unavailable.');
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return [key, {id: resource.id, pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}];
  }));
  const server = require('./screen-context.js').screenSessionPid(record.context.session);
  const children = fs.readFileSync(`/proc/${server}/task/${server}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).sort().map(pid => {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return {pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]};
  });
  return {geometry, windows, processes, children};
}

/** Confirm a split did not change unrelated panes before adopting its checkpoint. */
function verifySplit(record) {
  const pending = record.pending;
  const after = require('./layout.js').borkLayoutSnapshot(record).panes;
  const parent = record.resources[pending.operation.parent].id;
  const allowed = new Set([...Object.keys(pending.before.panes), pending.returned_id]);
  if (Object.keys(after).some(id => !allowed.has(id)) || !after[pending.returned_id]) throw new Error('Split produced an unexpected pane; retain pending intent.');
  for (const [id, pane] of Object.entries(pending.before.panes)) {
    const current = after[id];
    if (!current || ['window', 'session', 'pid', 'owner', 'placement', 'terminal', 'created_ms'].some(key => pane[key] !== undefined && pane[key] !== current[key])) throw new Error('Split changed a pane identity; retain pending intent.');
    if (id !== parent && ['x', 'y', 'width', 'height'].some(key => pane[key] !== current[key])) throw new Error('Split changed unrelated pane geometry; retain pending intent.');
  }
}

/** Resolve separator semantics for the selected host. */
function gap(record) { return record.driver === 'herdr' ? 0 : 1; }

/** Include measured App terminal chrome in logical admission bounds. */
function planFor(record, topology, reserve = false) { return demandPlan(record.plan.concurrency, record.plan.area, topology, gap(record), reserve, record.driver === 'hc' ? {width: 37, height: 8} : {width: 35, height: 6}); }

/** Verify ownership independently of current user focus. */
function verify(record, rendered = true) {
  if (record.version !== 2 || record.lifecycle !== 'demand' || record.state !== 'ready') throw new Error('Demand journal is not ready.');
  if (record.pending) throw new Error('Uncertain demand mutation requires layout reconcile; do not repeat the launch.');
  const snapshot = require('./layout.js').borkLayoutSnapshot(record);
  const ids = new Set(Object.values(record.resources).map(resource => resource.id));
  for (const [key, resource] of Object.entries(record.resources)) {
    const pane = snapshot.panes[resource.id];
    if (!pane || pane.window !== record.original.panes[record.coordinator].window) throw new Error('Owned demand pane missing or changed window.');
    if (record.driver === 'tmux' && key !== 'coordinator' && (pane.owner !== record.run_id || pane.placement !== key)) throw new Error('Demand pane ownership changed.');
    borkLayoutGeometry(record.plan.slots[key], pane, record.driver === 'herdr' ? 1 : 0);
    if (record.driver === 'herdr') {
      const info = require('./layout-adapters/herdr.js').borkLayoutHerdr(record.context, ['pane', 'process-info', '--pane', resource.id]).process_info;
      if (info.shell_pid !== resource.shell_pid) throw new Error('Herdr shell identity changed; preserve its occupant.');
    }
    if (record.driver === 'hc' && (pane.terminal !== resource.terminal && key !== 'coordinator' || (resource.visible_created_ms ?? resource.created_ms) && pane.created_ms !== (resource.visible_created_ms ?? resource.created_ms))) throw new Error('App shell terminal identity changed.');
    if (rendered && record.driver === 'hc' && resource.actual_cells && (pane.cols !== resource.actual_cells[0] || pane.rows !== resource.actual_cells[1])) throw new Error('Rendered App geometry changed; reconcile resize before another launch.');
  }
  for (const [id, pane] of Object.entries(record.original.panes)) {
    if (id !== record.coordinator) borkLayoutGeometry(pane, snapshot.panes[id] ?? {});
  }
  for (const id of Object.keys(snapshot.panes)) {
    if (!record.original.panes[id] && !ids.has(id)) throw new Error('Foreign pane appeared; reconcile before mutation.');
  }
  return snapshot;
}

/** Accept the desired topology only after independently verifying the live host. */
function finish(record) {
  const pending = record.pending;
  require('./layout-demand-host.js').reflow(record, ownedTree(pending.desired_plan, record.resources));
  record.plan = pending.desired_plan;
  record.pending = null;
  try { verify(record); } catch (error) { record.pending = pending; save(record); throw error; }
  record.generation++;
  record.capacity_generation++;
  for (const waiter of Object.values(record.capacity_waiters)) waiter.wake_generation = record.capacity_generation;
  save(record);
}

/** Initialize a versioned journal without creating future-role placeholders. */
function create(input, preflight) {
  if (!['tmux', 'herdr', 'hc', 'screen'].includes(input.driver)) throw new Error('Unsupported demand host.');
  const area = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, preflight.snapshot.panes[input.coordinator][key]]));
  const record = {...input, version: 2, lifecycle: 'demand', state: 'ready', context: preflight.context, capability: preflight.capability, original: preflight.snapshot, plan: demandPlan(input.concurrency ?? 1, area, {}, input.driver === 'herdr' ? 0 : 1), resources: {coordinator: {id: input.coordinator, state: 'protected'}}, history: [], pending: null, admissions: {}, capacity_waiters: {}, generation: 0, capacity_generation: 0};
  require('./layout-demand-host.js').initialize(record);
  if (record.driver === 'herdr') record.resources.coordinator.shell_pid = require('./layout-adapters/herdr.js').borkLayoutHerdr(record.context, ['pane', 'process-info', '--pane', record.coordinator]).process_info.shell_pid;
  verify(record);
  save(record);
  return record;
}

/** Reserve pair headroom durably, so concurrent master admission cannot deadlock tandems. */
function admission(record, input) {
  verify(record);
  const target = input.target_id;
  if (typeof target !== 'string' || !target) throw new Error('Admission requires a target identity.');
  const prior = Object.entries(record.admissions).find(([, value]) => value.target_id === target);
  if (prior) return {admitted: true, slot: Number(prior[0]), generation: record.capacity_generation};
  const occupied = new Set(Object.keys(record.admissions).map(Number));
  for (const slot of Object.keys(topologyFor(record.resources))) occupied.add(Number(slot));
  const slot = input.slot ?? Array.from({length: record.plan.concurrency}, (_, index) => index + 1).find(value => !occupied.has(value));
  if (slot !== undefined && (!Number.isInteger(slot) || slot < 1 || slot > record.plan.concurrency || occupied.has(slot))) throw new Error('Admission slot is invalid or belongs to another target.');
  const candidate = Object.fromEntries([...occupied].map(value => [value, ['master']]));
  if (slot !== undefined) candidate[slot] = ['master'];
  try {
    if (slot === undefined) { const error = new Error('All stable target slots are occupied.'); error.code = 'layout_capacity'; throw error; }
    planFor(record, candidate, true);
    record.admissions[slot] = {target_id: target, admitted_generation: record.capacity_generation};
    delete record.capacity_waiters[target];
    save(record);
    return {admitted: true, slot, generation: record.capacity_generation};
  } catch (error) {
    if (error.code !== 'layout_capacity') throw error;
    let impossible = false;
    try { planFor(record, {1: ['master']}, true); } catch (single) { if (single.code !== 'layout_capacity') throw single; impossible = true; }
    const result = {admitted: false, status: impossible ? 'blocked' : 'waiting_capacity', reason: error.message, actual: error.actual ?? record.plan.area, required: error.required ?? null, slot: slot ?? null, generation: record.capacity_generation};
    record.capacity_waiters[target] = result;
    save(record);
    return result;
  }
}

/** Release an unlaunched reservation after the owner has reconciled its stopped target. */
function cancelAdmission(input, record) {
  verify(record);
  if (input.master_stopped !== true || input.descendants_stopped !== true) throw new Error('Admission cancellation requires verified shutdown.');
  const entry = Object.entries(record.admissions).find(([, value]) => value.target_id === input.target_id);
  if (!entry) throw new Error('No admission belongs to this target.');
  if (record.resources[`master:${entry[0]}`]) throw new Error('Release the live master before cancelling admission.');
  delete record.admissions[entry[0]];
  record.capacity_generation++;
  save(record);
  return {cancelled: true, capacity_generation: record.capacity_generation};
}

/** Create exactly one imminent worker and journal its identity before any reflow. */
function claim(input, record) {
  const snapshot = verify(record);
  const {role, slot, target_id: target, task_id: task} = input;
  const key = `${role}:${slot}`;
  if (!['master', 'review', 'fix'].includes(role) || !Number.isInteger(slot) || slot < 1 || slot > record.plan.concurrency || typeof task !== 'string' || !task || typeof target !== 'string' || !target) throw new Error('Invalid demand claim identity.');
  if (record.resources[key]) throw new Error('Placement already exists; reconcile its original worker.');
  const master = record.resources[`master:${slot}`];
  if (role !== 'master' && (!master || master.target_id !== target)) throw new Error('Role target does not match its live master.');
  if (role === 'master') {
    const capacity = admission(record, input);
    if (!capacity.admitted) return capacity;
    if (capacity.slot !== slot) throw new Error('Claim slot differs from reserved admission.');
  }
  const topology = topologyFor(record.resources);
  (topology[slot] ??= []).push(role);
  const plan = planFor(record, topology);
  let parent;
  if (role === 'master') parent = Object.keys(record.resources).find(value => value.startsWith('master:')) ?? 'coordinator';
  else parent = record.resources[`${role === 'review' ? 'fix' : 'review'}:${slot}`] ? `${role === 'review' ? 'fix' : 'review'}:${slot}` : `master:${slot}`;
  const pane = snapshot.panes[record.resources[parent].id];
  const horizontal = role === 'master' ? parent === 'coordinator' : parent.startsWith('master:');
  const operation = {parent, new: key, direction: horizontal ? 'right' : 'down', size: Math.max(1, Math.floor(((horizontal ? pane.width : pane.height) - gap(record)) / 2))};
  record.pending = {kind: 'split', key, operation, target_id: target, task_id: task, run_id: input.run_id ?? record.run_id, desired_plan: plan, before: snapshot, step: 'split'};
  save(record);
  const id = require('./layout-demand-host.js').split(record, operation);
  record.pending.returned_id = id;
  save(record);
  verifySplit(record);
  record.pending.checkpoint = checkpoint(record);
  record.pending.uncertain = false;
  save(record);
  adoptSplit(record);
  finish(record);
  return record.resources[key];
}

/** Adopt only an explicitly returned pane identity, never infer a new worker from focus. */
function adoptSplit(record) {
  const pending = record.pending;
  if (record.resources[pending.key]) return;
  if (!pending.returned_id) throw new Error('Split response was lost; preserve intent and inspect host before explicit identity reconciliation.');
  const observed = require('./layout.js').borkLayoutSnapshot(record).panes[pending.returned_id];
  if (!observed || pending.before.panes[pending.returned_id]) throw new Error('Returned split identity is missing or predates this mutation.');
  record.resources[pending.key] = {id: pending.returned_id, state: 'claimed', target_id: pending.target_id, task_id: pending.task_id, run_id: pending.run_id, idle_pid: observed.pid ?? null, idle_command: observed.command ?? null, terminal: observed.terminal ?? null, created_ms: observed.created_ms ?? null};
  if (record.driver === 'herdr') record.resources[pending.key].shell_pid = require('./layout-adapters/herdr.js').borkLayoutHerdr(record.context, ['pane', 'process-info', '--pane', pending.returned_id]).process_info.shell_pid;
  save(record);
}

/** Record release history exactly once before making capacity available again. */
function acceptRemoval(record) {
  const pending = record.pending;
  if (!record.history.some(item => item.resource.id === pending.resource.id && item.resource.task_id === pending.resource.task_id)) record.history.push({placement: pending.key, resource: pending.resource, result_path: pending.result_path, worker_stopped: true, descendants_stopped: true});
  delete record.resources[pending.key];
  if (pending.key.startsWith('master:')) delete record.admissions[pending.key.split(':')[1]];
  if (record.driver === 'screen') {
    const path = `${record.record}.${pending.key.replace(':', '-')}.pid`;
    if (fs.existsSync(path)) fs.unlinkSync(path);
  }
  save(record);
}

/** Remove a finished role only after durable acceptance and verified process shutdown. */
function release(input, record) {
  if (input.results_verified !== true || input.worker_stopped !== true || input.descendants_stopped !== true) throw new Error('Release requires accepted results and stopped worker/descendants.');
  const snapshot = verify(record);
  const resource = record.resources[input.placement];
  if (!resource && record.history.some(item => item.placement === input.placement && item.resource.task_id === input.task_id && item.result_path === input.result_path)) return {state: 'removed', already_removed: true};
  if (!resource || resource.state !== 'claimed' || resource.task_id !== input.task_id) throw new Error('Release identity does not match claimed demand role.');
  const stat = fs.lstatSync(input.result_path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Release result must be a regular durable file.');
  const result = JSON.parse(fs.readFileSync(input.result_path, 'utf8'));
  if (!['complete', 'good', 'blocked'].includes(result.status)) throw new Error('Release requires a terminal role result.');
  if (input.placement.startsWith('master:') && ['review', 'fix'].some(role => record.resources[`${role}:${input.placement.split(':')[1]}`])) throw new Error('Release tandem children before their master.');
  require('./layout.js').borkLayoutIdle(record, input.placement);
  const topology = topologyFor(record.resources);
  const [role, slot] = input.placement.split(':');
  topology[slot] = topology[slot].filter(value => value !== role);
  if (!topology[slot].length) delete topology[slot];
  record.pending = {kind: 'close', key: input.placement, resource, desired_plan: planFor(record, topology), before: snapshot, result_path: input.result_path};
  record.pending.checkpoint = checkpoint(record);
  save(record);
  require('./layout-demand-host.js').step(record, `close:${resource.id}`, () => require('./layout-demand-host.js').close(record, resource.id));
  acceptRemoval(record);
  finish(record);
  return {state: 'removed', id: resource.id, capacity_released: true, capacity_generation: record.capacity_generation, waiting_targets: Object.keys(record.capacity_waiters)};
}

/** Resume known-ID reflow after helper restart without recreating or relaunching workers. */
function reconcile(input, record) {
  if (!record.pending) return {state: 'ready', snapshot: verify(record)};
  if (!record.pending.checkpoint) throw new Error('Pending host checkpoint is unavailable; preserve the journal and inspect the host.');
  const actual = checkpoint(record);
  if (JSON.stringify(actual) !== JSON.stringify(record.pending.checkpoint)) throw new Error('Pending host checkpoint changed or mutation completion is uncertain; preserve the journal and user geometry.');
  if (record.pending.kind === 'split') adoptSplit(record);
  else if (record.pending.kind === 'close') {
    const id = record.pending.resource.id;
    const snapshot = require('./layout.js').borkLayoutSnapshot(record);
    const hiddenScreen = record.driver === 'screen' && require('./layout-adapters/screen.js').borkLayoutScreen(record.context, ['-Q', 'windows', '%n|%f;']).split(';').some(entry => entry.trim().startsWith(id + '|'));
    if (snapshot.panes[id] || hiddenScreen) {
      require('./layout.js').borkLayoutIdle(record, record.pending.key);
      require('./layout-demand-host.js').step(record, `close:${id}`, () => require('./layout-demand-host.js').close(record, id));
    }
    acceptRemoval(record);
  } else throw new Error('Unknown pending demand operation; retain journal.');
  finish(record);
  return {state: 'ready', generation: record.generation, resources: record.resources};
}

/** Finish only after all physical workers and reservations have been released. */
function cleanup(input, record) {
  if (input.results_verified !== true || input.descendants_stopped !== true) throw new Error('Cleanup requires accepted results and stopped descendants.');
  verify(record);
  if (Object.keys(record.resources).length !== 1 || Object.keys(record.admissions).length) throw new Error('Release all demand workers and reservations before cleanup.');
  record.state = 'cleaned';
  save(record);
  return {state: 'cleaned', coordinator: record.coordinator};
}

module.exports = {groupsFor, demandPlan, topologyFor, parseTree, formatTree, ownedTree, checkpoint, verify, create, admission, cancelAdmission, claim, release, reconcile, cleanup};
