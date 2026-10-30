'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
/* Allocate a disposable directory owned by the current fixture. */
function temporary({prefix = 'bork-test-', dir = os.tmpdir()} = {}) {
    const name = fs.mkdtempSync(path.join(dir, prefix));
    return {name, cleanup() { fs.rmSync(name, {recursive: true, force: true}); }};
}
/* Wrap filesystem paths while keeping fixture operations explicit and synchronous. */
class FixturePath {
    constructor(value) { this.value = String(value); }
    toString() { return this.value; }
    [Symbol.toPrimitive]() { return this.value; }
    /* Join one owned fixture path. */
    join(value) { return P(path.join(this.value, String(value))); }
    /* Resolve a path including symlinks when it exists. */
    resolve() { return P(fs.realpathSync(this.value)); }
    /* Read the immediate parent. */
    get parent() { return P(path.dirname(this.value)); }
    /* Enumerate ancestors from the nearest parent. */
    get parents() { const result = []; let next = path.dirname(this.value); while (true) { result.push(P(next)); const parent = path.dirname(next); if (parent === next) return result; next = parent; } }
    /* Read the basename. */
    get name() { return path.basename(this.value); }
    /* Select a sibling. */
    withName(name) { return this.parent.join(name); }
    /* Read UTF-8 fixture content. */
    readText() { return fs.readFileSync(this.value, 'utf8'); }
    /* Read binary fixture content. */
    readBytes() { return fs.readFileSync(this.value); }
    /* Replace fixture text. */
    writeText(value) { fs.writeFileSync(this.value, value); }
    /* Replace binary fixture content. */
    writeBytes(value) { fs.writeFileSync(this.value, value); }
    /* Inspect existence. */
    exists() { return fs.existsSync(this.value); }
    /* Inspect directory status. */
    isDir() { return this.exists() && fs.statSync(this.value).isDirectory(); }
    /* Create a fixture directory without hiding unexpected collisions. */
    mkdir({mode = 0o777, exist_ok = false, parents = false} = {}) { if (exist_ok && this.isDir()) return; fs.mkdirSync(this.value, {mode, recursive: parents}); }
    /* Create an empty fixture file. */
    touch() { fs.closeSync(fs.openSync(this.value, 'a')); }
    /* Set executable or private fixture permissions. */
    chmod(mode) { fs.chmodSync(this.value, mode); }
    /* Link an explicit fixture target. */
    symlinkTo(target) { fs.symlinkSync(String(target), this.value); }
    /* Remove a fixture file with an explicit missing-file policy. */
    unlink({missing_ok = false} = {}) { try { fs.unlinkSync(this.value); } catch (error) { if (!missing_ok || error.code !== 'ENOENT') throw error; } }
    /* Enumerate direct children only. */
    iterdir() { return fs.readdirSync(this.value).map(name => this.join(name)); }
    /* Read filesystem metadata. */
    stat() { return fs.statSync(this.value); }
    /* Open an owned fixture stream for bounded synchronous writes. */
    open(mode) { const fd = fs.openSync(this.value, mode); return {fd, write(value) { fs.writeSync(fd, value); }, close() { fs.closeSync(fd); }}; }
}
/* Normalize a fixture path. */
function P(value) { return value instanceof FixturePath ? value : new FixturePath(value); }
/* Copy isolated runtime modules while omitting test-only artifacts. */
function copyTree(source, destination, {ignore = []} = {}) { fs.cpSync(String(source), String(destination), {recursive: true, filter: source => !ignore.some(pattern => pattern.startsWith('*.') ? source.endsWith(pattern.slice(1)) : path.basename(source) === pattern)}); }

module.exports = {fs, path, os, FixturePath, P, temporary, copyTree};
