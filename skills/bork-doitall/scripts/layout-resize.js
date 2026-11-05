'use strict';

/** Copy only measured terminal geometry. */
function rect(pane) {
  return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => {
    if (!Number.isInteger(pane[key]) || pane[key] < (key === 'width' || key === 'height' ? 1 : 0)) throw new Error('Resize needs verified positive pane geometry.');
    return [key, pane[key]];
  }));
}

/** Measure a rectangle enclosing retained pane identities. */
function bounds(panes) {
  const values = Object.values(panes).map(rect);
  const x = Math.min(...values.map(pane => pane.x)), y = Math.min(...values.map(pane => pane.y));
  return {x, y, width: Math.max(...values.map(pane => pane.x + pane.width)) - x, height: Math.max(...values.map(pane => pane.y + pane.height)) - y};
}

/** Retain pane order and split orientation while permitting different dimensions. */
function relations(panes) {
  const ids = Object.keys(panes).sort();
  return ids.flatMap((id, index) => ids.slice(index + 1).map(other => {
    const a = panes[id], b = panes[other];
    return [a.x + a.width <= b.x, b.x + b.width <= a.x, a.y + a.height <= b.y, b.y + b.height <= a.y];
  }));
}

/** Detect font or viewport changes in rendered App terminal cells. */
function renderedChanged(record, snapshot) {
  return record.driver === 'hc' && Object.values(record.resources).some(resource => resource.actual_cells && snapshot.panes[resource.id] && JSON.stringify(resource.actual_cells) !== JSON.stringify([snapshot.panes[resource.id].cols, snapshot.panes[resource.id].rows]));
}

/** Remeasure App root capacity instead of retaining its original cell scale. */
function refreshSnapshot(record, snapshot) {
  return renderedChanged(record, snapshot) ? require('./layout-adapters/hc-app.js').borkLayoutAppSnapshot({...record.context, root_area: null}, record.coordinator) : snapshot;
}

/** Adopt a settled window resize without moving panes or changing process identities. */
function adoptResize(record, snapshot, rendered = true) {
  const expected = {...record.original.panes};
  for (const [key, resource] of Object.entries(record.resources)) expected[resource.id] = record.plan.slots[key];
  const before = bounds(expected), after = bounds(snapshot.panes);
  const cellsChanged = rendered && renderedChanged(record, snapshot);
  if (JSON.stringify(before) === JSON.stringify(after) && !cellsChanged) return false;
  if (JSON.stringify(relations(expected)) !== JSON.stringify(relations(snapshot.panes))) throw new Error('Resize changed pane order or split topology; preserve the layout.');
  const owned = Object.fromEntries(Object.values(record.resources).map(resource => [resource.id, snapshot.panes[resource.id]]));
  const area = bounds(owned);
  const slots = Object.fromEntries(Object.entries(record.resources).map(([key, resource]) => [key, rect(snapshot.panes[resource.id])]));
  const original = structuredClone(record.original);
  for (const [id, pane] of Object.entries(original.panes)) Object.assign(pane, id === record.coordinator ? area : rect(snapshot.panes[id]));
  /** Refresh scaffolding rectangles so later reflows preserve resized foreign panes. */
  function scaffold(node) {
    if (node.id) return {...node, ...rect(original.panes[node.id])};
    const children = node.children.map(scaffold);
    return {...node, ...bounds(Object.fromEntries(children.map((child, index) => [index, child]))), children};
  }
  const tree = record.host_tree ? scaffold(record.host_tree) : null;
  record.plan = {...record.plan, area, slots};
  record.original = original;
  if (tree) record.host_tree = tree;
  if (cellsChanged) for (const resource of Object.values(record.resources)) resource.actual_cells = [snapshot.panes[resource.id].cols, snapshot.panes[resource.id].rows];
  if (record.driver === 'hc' && snapshot.root_area) {
    record.context.root_area = snapshot.root_area;
    record.original.root_area = snapshot.root_area;
  }
  record.generation = (record.generation ?? 0) + 1;
  record.capacity_generation = (record.capacity_generation ?? 0) + 1;
  for (const waiter of Object.values(record.capacity_waiters ?? {})) waiter.wake_generation = record.capacity_generation;
  return true;
}

module.exports = {adoptResize, refreshSnapshot};
