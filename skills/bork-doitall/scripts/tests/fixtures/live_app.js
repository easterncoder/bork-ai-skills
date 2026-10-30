'use strict';
const {assert, fs, P, temporary, run, background, sleep, json} = require('../../../../../tests/support.js');
const SCRIPTS = P(__filename).parents[2];
/* Flatten only the displayed App split tree in traversal order. */
function leaves(node) { return node.type === 'block' ? [node] : (node.children ?? []).flatMap(leaves); }
/* Exercise a private App home, core session and X display without real agents. */
function main() {
    const temp = temporary({prefix: 'bork-app-probe-'}), root = P(temp.name), session = 'bork-app-probe-'+process.pid;
    const env = {...process.env, HERDR_APP_HOME: String(root.join('home')), XDG_STATE_HOME: String(root.join('state')), HC_SESSION: session, HERDR_APP_NO_SOUND: '1', WAYLAND_DISPLAY: ''}; delete env.HC_TERMINAL_ID;
    let x, app, ownedCore;
    /* Run one bounded argument vector against the private endpoints. */
    function command(argv, check = true) { return run(argv, {env, check, timeout: 10}); }
    /* Send one JSON-RPC request to this fixture's private core. */
    function rpc(method, params = {}) {
        const result = run(['hc', 'connect', '--session', session], {input: json({jsonrpc: '2.0', id: 1, method, params})+'\n', env, check: true});
        const value = JSON.parse(result.stdout); assert.ok(!value.error, result.stdout); return value.result;
    }
    /* Wait for bounded document persistence following a UI operation. */
    function waitDoc(predicate) { for (let count = 0; count < 100; count++) { const doc = rpc('doc.get', {name: 'herdr-app'}); if (doc.value && predicate(doc.value)) return doc; sleep(.05); } throw new Error('doc persistence timeout'); }
    /* Start only the fixture's App process in its own group. */
    function startApp() { return background(['herdr-app'], {env}); }
    /* Wait for this App to expose its private control endpoint. */
    function waitApp() { for (let count = 0; count < 100; count++) { const result = command(['herdr-app', 'status'], false); if (result.status === 0) return result; if (app.poll() !== null) throw new Error('App exited: '+fs.readFileSync(app.stdoutPath, 'utf8')); sleep(.1); } throw new Error('Private App status timeout'); }
    /* Stop an owned process group with a bounded kill fallback. */
    function stop(child) {
        if (!child) return;
        if (child.poll() === null) { process.kill(-child.pid, 'SIGTERM'); try { child.wait({timeout: 5}); } catch { if (child.poll() === null) process.kill(-child.pid, 'SIGKILL'); child.wait({timeout: 5}); } }
        child.dispose();
    }
    try {
        x = background(['Xvfb', '-displayfd', '1', '-screen', '0', '2000x1600x24', '-nolisten', 'tcp']);
        for (let count = 0; count < 30 && !fs.statSync(x.stdoutPath).size; count++) sleep(.1);
        env.DISPLAY = ':'+fs.readFileSync(x.stdoutPath, 'utf8').trim(); assert.match(env.DISPLAY, /^:\d+$/);
        P(env.HERDR_APP_HOME).mkdir();
        P(env.HERDR_APP_HOME).join('window.json').writeText(json({state: 'windowed', bounds: [0, 0, 1800, 1400]}));
        P(env.HERDR_APP_HOME).join('shared.json').writeText(json({'frame.welcomed': 'skipped'}));
        app = startApp(); const status = waitApp();
        console.log('ROOT', String(root), 'SESSION', session, 'DISPLAY', env.DISPLAY);
        ownedCore = rpc('server.status'); assert.ok(ownedCore.pid > 0); console.log('PRIVATE_CORE', ownedCore, 'STATUS', status.stdout);
        command(['herdr-app', 'do', 'layout.switch', json({name: 'terminals'})]); command(['herdr-app', 'do', 'layout.switch', json({name: 'main'})]);
        command(['herdr-app', 'do', 'space.new', json({name: 'bork-probe', folder: String(root), argv: ['/bin/sh']})]);
        const doc = waitDoc(value => value.spaces.length === 1), fixture = doc.value.spaces[0].tabs[0];
        const tab = fixture.id, pane = fixture.root.children[0].id, coordinator = fixture.root.children[0].content.terminal;
        command(['herdr-app', 'do', 'tab.new', json({name: 'unrelated', argv: ['/bin/sh']})]);
        const unrelated = waitDoc(value => value.spaces[0].tabs.length === 2).value.spaces[0].tabs[1];
        command(['herdr-app', 'do', 'pane.focus', json({pane})]); sleep(.3);
        const original = rpc('terminal.get', {terminal: coordinator}); console.log('ORIGINAL_DIMENSIONS', original.cols, original.rows);
        const summary = [];
        for (const concurrency of [1, 2, 3]) {
            const request = {driver: 'hc', visual_host: 'herdr-app', context: {session, app_home: env.HERDR_APP_HOME}, coordinator: pane, concurrency, run_id: 'adapter'+concurrency, cwd: String(root), record: String(root.join('layout-'+concurrency+'.json'))};
            /* Exercise actual layout actions with independent immutable requests. */
            function layout(action, extra = {}, success = true) {
                const input = root.join('input.json'); input.writeText(json({...request, ...extra}));
                const result = command([process.execPath, SCRIPTS.join('layout.js'), action, input], false);
                console.log('ACTION', concurrency, action, result.status ? result.stdout : 'PASS');
                if (success) assert.equal(result.status, 0, result.stdout+result.stderr); return JSON.parse(result.stdout);
            }
            const result = layout('create').result; assert.equal(result.state, 'ready'); assert.equal(layout('inspect').result.snapshot.focus, pane);
            assert.equal(layout('claim', {role: 'review', slot: 1, task_id: 'fixture', target_id: 'i10'}).result.id, result.resources['review:1'].id);
            layout('claim', {role: 'review', slot: 1, task_id: 'duplicate', target_id: 'i10'}, false);
            const role = root.join('role-result.json'); role.writeText(json({status: 'complete'}));
            layout('release', {placement: 'review:1', task_id: 'fixture', result_path: String(role), results_verified: true, descendants_stopped: true, worker_stopped: true});
            if (concurrency === 1) {
                const job = root.join('worker-job.json'); job.writeText(json({argv: [process.execPath, '-e', 'console.log("visible worker");setTimeout(()=>{},30000);'], exit_record: String(root.join('worker-exit.json'))}));
                const launch = {record: String(root.join('hc-worker.json')), job: String(job), cwd: String(root), name: 'fixture-worker', role: 'master', slot: 1, run_id: 'adapter1', task_id: 'master-live', target_id: 'i10', session, layout_record: request.record};
                /* Exercise the actual hc lifecycle on its owned terminal. */
                function lifecycle(action, data) { const input = root.join('hc-input.json'); input.writeText(json(data)); const result = command([process.execPath, SCRIPTS.join('hc.js'), action, input], false); console.log('HC', action, result.status ? result.stdout : 'PASS'); assert.equal(result.status, 0, result.stdout+result.stderr); return JSON.parse(result.stdout).result; }
                const worker = lifecycle('launch', launch); sleep(.3);
                const geometry = rpc('terminal.get', {terminal: worker.terminal_id}); assert.ok(geometry.cols >= 35 && geometry.rows >= 6, json(geometry));
                lifecycle('inspect', {record: launch.record}); command(['herdr-app', 'shot', String(root.join('worker-visible.png'))]);
                stop(app); app = startApp(); waitApp(); lifecycle('reconcile', {record: launch.record});
                assert.equal(lifecycle('cleanup', {record: launch.record, results_verified: true, descendants_stopped: true}).state, 'removed');
                layout('release', {placement: 'master:1', task_id: 'master-live', result_path: String(role), results_verified: true, descendants_stopped: true, worker_stopped: true});
            }
            sleep(.2); const current = JSON.parse(command(['herdr-app', 'status']).stdout);
            assert.equal(current.focused_pane, pane); assert.deepEqual(current.errors, []); assert.deepEqual(current.overlays, []);
            command(['herdr-app', 'shot', String(root.join('adapter-'+concurrency+'.png'))]);
            layout('cleanup', {results_verified: true, descendants_stopped: true});
            const final = waitDoc(value => leaves(value.spaces[0].tabs.find(item => item.id === tab).root).length === 1);
            assert.deepEqual(final.value.spaces[0].tabs.find(item => item.id === unrelated.id), unrelated);
            summary.push({concurrency, status: 'PASS', record: request.record});
        }
        root.join('summary.json').writeText(json(summary, {indent: 2}));
    } finally {
        try { stop(app); }
        finally {
            try {
                if (ownedCore) {
                    const latest = rpc('server.status'), procenv = fs.readFileSync(`/proc/${latest.pid}/environ`, 'utf8').split('\0');
                    assert.equal(latest.core.id, ownedCore.core.id); assert.equal(latest.pid, ownedCore.pid); assert.ok(procenv.includes('HC_SESSION='+session));
                    console.log('STOP_PRIVATE_CORE', rpc('server.stop'));
                }
            } finally { stop(x); console.log('CLEANED', String(root)); }
        }
    }
}
if (require.main === module) main();
module.exports = {main};
