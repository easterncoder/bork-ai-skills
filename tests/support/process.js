'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync, spawn} = require('node:child_process');
const {temporary} = require('./filesystem.js');
/* Pause synchronous fixture polling without a busy loop. */
function sleep(seconds) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000); }
/* Resolve an executable without consulting a shell. */
function which(name) {
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
        const candidate = path.isAbsolute(name) ? name : path.join(directory, name);
        try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
        if (path.isAbsolute(name)) break;
    }
    return null;
}
/* Run an isolated argument vector with a mandatory bounded lifetime. */
function run(argv, options = {}) {
    const result = spawnSync(String(argv[0]), argv.slice(1).map(String), {
        cwd: options.cwd && String(options.cwd), env: options.env, input: options.input,
        encoding: 'utf8', timeout: (options.timeout ?? 10) * 1000, maxBuffer: 16 * 1024 * 1024,
        killSignal: 'SIGKILL', detached: true, stdio: options.stdin ? [options.stdin.fd, 'pipe', 'pipe'] : undefined,
    });
    if (result.error) { try { process.kill(-result.pid, 'SIGKILL'); } catch {} throw result.error; }
    if (options.check && result.status !== 0) throw new Error(`${JSON.stringify(argv)} exited ${result.status}: ${result.stderr}${result.stdout}`);
    return result;
}
/* Return checked stdout for short fixture controls. */
function output(argv, options = {}) { return run(argv, {...options, check: true}).stdout; }
/* Manage asynchronous processes through private output and completion records. */
function background(argv, options = {}) {
    const temp = temporary({prefix: 'bork-child-'});
    const stdout = path.join(temp.name, 'stdout'), stderr = path.join(temp.name, 'stderr'), status = path.join(temp.name, 'status');
    const launcher = path.join(temp.name, 'launcher.js');
    fs.writeFileSync(launcher, `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const argv=JSON.parse(process.argv[2]); const child=spawn(argv[0],argv.slice(1),{stdio:'inherit'}); child.on('error',e=>{fs.writeFileSync(process.argv[3],'127');process.exitCode=127}); child.on('exit',(code,signal)=>{fs.writeFileSync(process.argv[3],String(code??128));process.exitCode=code??128});`);
    const out = fs.openSync(stdout, 'w'), err = fs.openSync(stderr, 'w');
    const child = spawn(process.execPath, [launcher, JSON.stringify(argv.map(String)), status], {cwd: options.cwd && String(options.cwd), env: options.env, detached: true, stdio: ['ignore', out, err]});
    fs.closeSync(out); fs.closeSync(err); child.unref();
    /* Read process completion including a killed process group. */
    let lastStatus = null;
    function poll() { if (lastStatus !== null) return lastStatus; if (fs.existsSync(status)) return lastStatus = Number(fs.readFileSync(status, 'utf8')); try { const state = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1][0]; return state === 'Z' ? 128 : null; } catch { return 128; } }
    /* Wait for bounded completion and retain command diagnostics. */
    function wait({timeout = 10} = {}) { const deadline = Date.now() + timeout * 1000; while (poll() === null) { if (Date.now() >= deadline) { process.kill(-child.pid, 'SIGKILL'); throw new Error('Fixture subprocess timeout: '+JSON.stringify(argv)); } sleep(.01); } return poll(); }
    return {pid: child.pid, get status() { return poll(); }, poll, wait, dispose() { temp.cleanup(); }, stdoutPath: stdout, stderr: {close() { if (poll() !== null) temp.cleanup(); }}, communicate(opts) { wait(opts); const result = [fs.readFileSync(stdout, 'utf8'), fs.readFileSync(stderr, 'utf8')]; temp.cleanup(); return result; }};
}

module.exports = {sleep, which, run, checkOutput: output, background};
