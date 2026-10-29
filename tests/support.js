'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {test} = require('node:test');
const files = require('./support/filesystem.js');
const processes = require('./support/process.js');
const environment = require('./support/environment.js');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Tests require Node.js 22 or newer');
const signal = {SIGKILL: 'SIGKILL', SIGTERM: 'SIGTERM'};
/* Compare fixture values structurally. */
function equal(left, right) { try { assert.deepEqual(left, right); return true; } catch { return false; } }
/* Test object keys or structural array membership. */
function contains(container, value) { if (typeof container === 'string') return container.includes(value); if (container instanceof Set) return container.has(value); if (Array.isArray(container)) return container.some(item => equal(item, value)); return Object.hasOwn(container, value); }
/* Produce a bounded numeric iteration sequence. */
function range(start, end) { if (end === undefined) { end = start; start = 0; } return Array.from({length: Math.max(0, end - start)}, (_, index) => start + index); }
/* Pair independent fixture lists. */
function zip(left, right) { return left.map((value, index) => [value, right[index]]); }
/* Retain scenario indices. */
function enumerate(values) { return values.map((value, index) => [index, value]); }
/* Expand the environment selection matrix. */
function product(values, {repeat = 1} = {}) { let rows = [[]]; for (let index = 0; index < repeat; index++) rows = rows.flatMap(row => values.map(value => [...row, value])); return rows; }
/* Serialize fixture records with optional deterministic legacy fingerprints. */
function json(value, {sort_keys = false, ensure_ascii = false, indent} = {}) {
    if (sort_keys) {
        const sort = item => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
        value = sort(value);
    }
    let result = JSON.stringify(value, null, indent);
    if (ensure_ascii) result = result.replace(/[\u007f-\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    return result;
}
/* Hash actual fixture bytes. */
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
/* Remove one optional environment field. */
function pop(value, key, fallback = null) { const result = value[key] ?? fallback; delete value[key]; return result; }
/* Join text or binary procfs fixture fields. */
function join(separator, values) { return Buffer.isBuffer(separator) ? Buffer.concat(values.flatMap((value, index) => index ? [separator, value] : [value])) : values.join(separator); }
/* Quote a literal POSIX shell operand used by private terminal fixtures. */
function quote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }
/* Build a private terminal command from literal operands. */
function shellJoin(values) { return values.map(quote).join(' '); }
/* Extract keyword options after a variable argument vector. */
function takeOptions(args) { return args.length && typeof args.at(-1) === 'object' && !(args.at(-1) instanceof files.FixturePath) ? args.pop() : {}; }
/* Hold per-case cleanup callbacks and assertion diagnostics. */
class Fixture {
    constructor() { this.cleanups = []; }
    /* Register an owned resource cleanup. */
    addCleanup(callback) { this.cleanups.push(callback); }
    /* Compare structural fixture values. */
    assertEqual(actual, expected, message) { assert.deepEqual(actual, expected, message); }
    /* Require different structural values. */
    assertNotEqual(actual, expected, message) { assert.notDeepEqual(actual, expected, message); }
    /* Require truthy observable behavior. */
    assertTrue(value, message) { assert.ok(value, typeof message === 'string' ? message : JSON.stringify(message)); }
    /* Require falsy observable behavior. */
    assertFalse(value, message) { assert.ok(!value, typeof message === 'string' ? message : JSON.stringify(message)); }
    /* Require literal or structural membership. */
    assertIn(value, container, message) { assert.ok(contains(container, value), message ?? `${JSON.stringify(value)} absent from ${JSON.stringify(container)}`); }
    /* Reject literal or structural membership. */
    assertNotIn(value, container, message) { assert.ok(!contains(container, value), message); }
    /* Require an explicit null. */
    assertIsNone(value) { assert.equal(value, null); }
    /* Match a documented diagnostic. */
    assertRegex(value, pattern) { assert.match(value, new RegExp(pattern)); }
    /* Compare numeric geometry with a bounded tolerance. */
    assertAlmostEqual(actual, expected, {delta = 1e-7} = {}) { assert.ok(Math.abs(actual - expected) <= delta, `${actual} differs from ${expected}`); }
    /* Require increasing geometry or evidence values. */
    assertGreater(actual, expected) { assert.ok(actual > expected); }
    /* Fail with a retained fixture diagnostic. */
    fail(message) { assert.fail(message); }
}
/* Register independently isolated cases with Node's built-in test runner. */
function suite(Type, skips = {}) {
    for (const name of Object.getOwnPropertyNames(Type.prototype).filter(name => name.startsWith('test_'))) {
        test(`${Type.name}.${name}`, {skip: skips[name] || false, timeout: 650000}, () => {
            const fixture = new Type();
            try { fixture.setUp?.(); fixture[name](); }
            finally { try { fixture.tearDown?.(); } finally { for (const cleanup of fixture.cleanups.reverse()) cleanup(); } }
        });
    }
}

module.exports = {...files, ...processes, ...environment, assert, Fixture, suite, range, zip, enumerate, product, json, sha256, pop, join, quote, shellJoin, signal, takeOptions};
