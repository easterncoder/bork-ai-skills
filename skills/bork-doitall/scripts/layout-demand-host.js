'use strict';

const c = require('../../bork-review/scripts/support.js');
const t = require('./layout-adapters/tmux.js');
const h = require('./layout-adapters/herdr.js');
const a = require('./layout-adapters/hc-app.js');
const s = require('./layout-adapters/screen.js');

/** Preserve intent before each externally visible reflow step. */
function step(record, label, callback) {
  record.pending.step = label;
  require('./layout.js').borkLayoutWrite(record.record, record);
  const result = callback();
  record.pending.completed_steps ??= [];
  record.pending.completed_steps.push(label);
  require('./layout.js').borkLayoutWrite(record.record, record);
  return result;
}

/** Replace the original coordinator leaf without rewriting surrounding split geometry. */
function graft(node, coordinator, replacement) {
  if (node.id === coordinator) return replacement;
  return node.children ? {...node, children: node.children.map(child => graft(child, coordinator, replacement))} : node;
}

/** Read the stable identities in traversal order. */
function leaves(node) { return node.children ? node.children.flatMap(leaves) : [node.id]; }

/** Reorder tmux's pane list before applying measured layout cells. */
function tmuxReflow(record, tree) {
  const d = require('./layout-demand.js');
  const desired = graft(record.host_tree, record.coordinator, tree);
  for (const [index, id] of leaves(desired).entries()) {
    const order = t.borkLayoutTmux(record.context, ['list-panes', '-t', record.coordinator, '-F', '#{pane_id}']).trim().split('\n');
    if (order[index] !== id) step(record, `swap:${id}:${order[index]}`, () => t.borkLayoutTmux(record.context, ['swap-pane', '-d', '-s', id, '-t', order[index]]));
  }
  step(record, 'select-layout', () => t.borkLayoutTmux(record.context, ['select-layout', '-t', record.coordinator, d.formatTree(desired)]));
}

/** Convert measured owned cells to public weighted App nodes using retained leaves. */
function appNodes(record, tree, existing) {
  if (tree.id) {
    const node = existing.get(tree.id);
    if (!node) throw new Error('App pane identity missing during reflow.');
    return structuredClone(node);
  }
  return {id: `${record.run_id}-demand-${record.generation}-${tree.x}-${tree.y}-${tree.axis}`, type: tree.axis, children: tree.children.map(child => ({...appNodes(record, child, existing), size: {weight: child[tree.axis === 'row' ? 'width' : 'height']}}))};
}

/** Publish only the owned App subtree using a fresh complete-document CAS. */
function appReflow(record, tree) {
  const document = a.borkLayoutAppRpc(record.context, 'doc.get', {name: 'herdr-app'});
  const current = document.value.spaces.flatMap(space => space.tabs).find(tab => tab.id === record.original.tree.tab);
  if (!current) throw new Error('Recorded App tab disappeared.');
  const existing = new Map(), containers = new Map();
  /** Index retained public leaf nodes with their terminal references. */
  function index(node) { if (node.type === 'block') existing.set(node.id, node); else { containers.set(node.id, node); node.children.forEach(index); } }
  index(current.root);
  const replacement = appNodes(record, tree, existing);
  /** Reuse current foreign leaves while retaining their original container shares. */
  function scaffold(node) {
    if (node.id === record.coordinator) return {...replacement, size: node.size ?? {weight: 1}};
    if (node.type === 'block') return structuredClone(existing.get(node.id));
    return {...(containers.get(node.id) ?? node), children: node.children.map(scaffold)};
  }
  current.root = scaffold(record.original.tree.root);
  step(record, 'doc.set', () => a.borkLayoutAppRpc(record.context, 'doc.set', {name: 'herdr-app', version: document.version, value: document.value}));
  a.borkLayoutAppAwait(record.context, record.coordinator, observed => leaves(observed.root).join('|') === leaves(current.root).join('|'));
  /* Wait for rendered cells to catch up, including unchanged foreign terminal sizes. */
  const until = Date.now() + 5000;
  let previous, consecutive = 0;
  do {
    const snapshot = require('./layout.js').borkLayoutSnapshot(record);
    const cells = Object.values(snapshot.panes).map(pane => [pane.id, pane.cols, pane.rows]);
    const matches = Object.entries(record.resources).every(([key, resource]) => {
      const pane = snapshot.panes[resource.id], expected = record.pending.desired_plan.slots[key];
      return pane.cols >= (key === 'coordinator' ? 1 : 35) && pane.rows >= (key === 'coordinator' ? 1 : 6) && pane.cols <= expected.width + 3 && pane.cols >= expected.width - 3 && pane.rows <= expected.height + 3 && pane.rows >= expected.height - 3;
    });
    const foreign = Object.entries(record.original.panes).every(([id, pane]) => id === record.coordinator || (snapshot.panes[id]?.cols === pane.cols && snapshot.panes[id]?.rows === pane.rows));
    consecutive = matches && foreign && JSON.stringify(cells) === previous ? consecutive + 1 : 0;
    if (consecutive >= 5) {
      for (const resource of Object.values(record.resources)) resource.actual_cells = [snapshot.panes[resource.id].cols, snapshot.panes[resource.id].rows];
      return;
    }
    previous = JSON.stringify(cells);
    c.usleep(100000);
  } while (Date.now() < until);
  throw new Error('Rendered App cells did not confirm usable demand topology; retain pending intent.');
}

/** Rebuild Herdr's owned subtree with existing leaves and a focus-preserving pivot. */
function herdrReflow(record, tree) {
  const originalTab = record.original.panes[record.coordinator].window;
  const ids = leaves(tree);
  const focus = h.borkLayoutHerdr(record.context, ['api', 'snapshot']).snapshot.focused_pane_id;
  const pivot = ids.includes(focus) ? focus : record.coordinator;
  record.pending.pivot = pivot;
  require('./layout.js').borkLayoutWrite(record.record, record);
  /** Refuse to restore stale focus after concurrent user navigation. */
  function guarded(label, args) {
    const before = h.borkLayoutHerdr(record.context, ['api', 'snapshot']).snapshot;
    if (before.focused_pane_id !== focus) throw new Error('User navigated during Herdr reflow; preserve pending intent without restoring stale focus.');
    return step(record, label, () => h.borkLayoutHerdr(record.context, args));
  }
  for (const id of ids) if (id !== pivot) guarded(`stage:${id}`, ['pane', 'move', id, '--new-tab', '--label', `${record.run_id}-reflow`, '--no-focus']);
  const assigned = new Map(ids.map((id, index) => [id, [pivot, ...ids.filter(value => value !== pivot)][index]]));
  const positions = [];
  /** Recursively attach retained leaves using final topology, without extra shells. */
  function build(node, anchor) {
    if (node.id) { positions.push({wanted: node.id, actual: anchor}); return; }
    let remaining = node[node.axis === 'row' ? 'width' : 'height'];
    const anchors = [anchor];
    for (let index = 1; index < node.children.length; index++) {
      const id = assigned.get(leaves(node.children[index])[0]);
      const retained = node.children[index - 1][node.axis === 'row' ? 'width' : 'height'];
      const ratio = retained / remaining;
      guarded(`attach:${id}`, ['pane', 'move', id, '--tab', originalTab, '--target-pane', anchors[index - 1], '--split', node.axis === 'row' ? 'right' : 'down', '--ratio', String(ratio), '--no-focus']);
      anchors.push(id);
      remaining -= retained;
    }
    node.children.forEach((child, index) => build(child, anchors[index]));
  }
  build(tree, pivot);
  /** Swap with the focused pivot as source, preserving its focus at each boundary. */
  function swap(left, right) {
    guarded(`swap:${left}:${right}`, ['pane', 'swap', '--source-pane', left, '--target-pane', right]);
    for (const position of positions) {
      if (position.actual === left) position.actual = right;
      else if (position.actual === right) position.actual = left;
    }
  }
  for (const position of positions) {
    if (position.actual === position.wanted) continue;
    if (!ids.includes(focus)) {
      /* Nonfocused pane moves already preserve focus; swap would steal it. */
      throw new Error('Internal Herdr identity assignment requires focused pivot.');
    }
    const left = position.actual, right = position.wanted;
    if (left === pivot || right === pivot) swap(pivot, left === pivot ? right : left);
    else { swap(pivot, left); swap(pivot, right); swap(pivot, left); }
  }
}

/** Rebuild Screen regions while retaining every existing window and shell process. */
function screenReflow(record, tree) {
  return s.screenNavigation(record.context, () => {
    const ctx = record.context;
    const focus = s.borkLayoutScreen(ctx, ['-Q', 'number']).split(' ', 1)[0];
    const ids = leaves(tree);
    /** Apply a guarded control with durable recovery intent. */
    function command(label, args) { return step(record, label, () => s.borkLayoutScreen(ctx, ['-X', ...args])); }
    try {
      for (const id of ids) if (id !== record.coordinator) {
        const snapshot = s.borkLayoutScreenSnapshot(ctx, record.coordinator);
        if (snapshot.panes[id]) { s.borkLayoutScreenFocus(ctx, id); command(`remove-region:${id}`, ['remove']); }
      }
      s.borkLayoutScreenFocus(ctx, record.coordinator);
      command('restore-owned-width', ['resize', '-h', String(record.plan.area.width + 1)]);
      command('restore-owned-height', ['resize', '-v', String(record.plan.area.height + 1)]);
      /** Split measured regions and display retained window identities. */
      function build(node, anchor) {
        if (node.id) { s.borkLayoutScreenFocus(ctx, anchor); command(`bind:${node.id}`, ['select', node.id]); return; }
        const anchors = [anchor];
        for (let index = 1; index < node.children.length; index++) {
          s.borkLayoutScreenFocus(ctx, anchors[index - 1]);
          command(`split:${index}:${anchor}`, node.axis === 'row' ? ['split', '-v'] : ['split']);
          command('focus-new-region', ['focus', 'next']);
          const id = leaves(node.children[index])[0];
          command(`select:${id}`, ['select', id]);
          anchors.push(id);
        }
        node.children.forEach((child, index) => build(child, anchors[index]));
      }
      build(tree, record.coordinator);
      const rectangles = {...record.original.panes};
      for (const [key, resource] of Object.entries(record.resources)) rectangles[resource.id] = record.pending.desired_plan.slots[key];
      for (let pass = 0; pass < 2; pass++) for (const [id, rect] of Object.entries(rectangles)) {
        s.borkLayoutScreenFocus(ctx, id);
        command(`size:${id}`, ['resize', '-h', String(rect.width + 1)]);
        command(`height:${id}`, ['resize', '-v', String(rect.height + 1)]);
      }
    } finally { s.borkLayoutScreenFocus(ctx, focus); }
  });
}

/** Initialize immutable host scaffolding for the empty demand journal. */
function initialize(record) {
  if (record.driver === 'tmux') record.host_tree = require('./layout-demand.js').parseTree(t.borkLayoutTmux(record.context, ['display-message', '-p', '-t', record.coordinator, '#{window_layout}']));
  if (record.driver === 'hc') {
    record.context.root_area = record.original.root_area;
    record.context.core_id = record.original.tree.core_id;
  }
}

/** Create only the requested shell using the selected host's verified split primitive. */
function split(record, operation) {
  return ({tmux: t.borkLayoutTmuxSplit, herdr: h.borkLayoutHerdrSplit, hc: a.borkLayoutAppSplit, screen: s.borkLayoutScreenSplit})[record.driver](record, operation);
}

/** Close one verified stopped role without killing any surviving worker. */
function close(record, id) {
  if (record.driver === 'tmux') {
    require('./layout.js').borkLayoutCleanupFocus(record, id);
    return t.borkLayoutTmux(record.context, ['kill-pane', '-t', id]);
  }
  if (record.driver === 'hc') {
    require('./layout.js').borkLayoutCleanupFocus(record, id);
    a.borkLayoutAppCommand(record.context, 'pane.close', {pane: id});
    return a.borkLayoutAppAwait(record.context, record.coordinator, tree => a.borkLayoutAppFind(tree.root, id) === null);
  }
  if (record.driver === 'herdr') {
    require('./layout.js').borkLayoutCleanupFocus(record, id);
    return h.borkLayoutHerdr(record.context, ['pane', 'close', id]);
  }
  return s.screenNavigation(record.context, () => {
    const focus = s.borkLayoutScreen(record.context, ['-Q', 'number']).split(' ', 1)[0];
    const snapshot = s.borkLayoutScreenSnapshot(record.context, record.coordinator);
    if (snapshot.panes[id]) {
      s.borkLayoutScreenFocus(record.context, id);
      step(record, `remove-region:${id}`, () => s.borkLayoutScreen(record.context, ['-X', 'remove']));
    }
    step(record, `kill-window:${id}`, () => s.borkLayoutScreen(record.context, ['-p', id, '-X', 'kill']));
    s.borkLayoutScreenFocus(record.context, focus === id ? record.coordinator : focus);
  });
}

/** Apply host reflow without selecting or raising unrelated windows. */
function reflow(record, tree) { return ({tmux: tmuxReflow, herdr: herdrReflow, hc: appReflow, screen: screenReflow})[record.driver](record, tree); }

module.exports = {step, graft, leaves, initialize, split, close, reflow};
