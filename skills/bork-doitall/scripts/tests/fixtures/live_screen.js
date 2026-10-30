'use strict';
const {assert, fs, P, temporary, run, sleep, json} = require('../../../../../tests/support.js');
const {privatePty} = require('../../../../../tests/fixtures/pty.js');
const SCRIPTS = P(__filename).parents[2];
/* Exercise only private attached Screen displays and retain exact visual evidence. */
function main() {
    const evidence = temporary({prefix: 'bork-screen-adapter-'}), reports = [];
    for (const concurrency of [1, 2, 3]) {
        const temp = temporary({prefix: 'screen-tree-research-'}), root = P(temp.name);
        root.chmod(0o700);
        const env = {...process.env, SCREENDIR: String(root), TERM: 'xterm-256color'}; delete env.STY;
        const rc = root.join('rc'); rc.writeText('startup_message off\nmsgwait 0\ncaption always "%n %t"\n');
        const pty = privatePty(['screen', '-m', '-S', 'tree', '-c', String(rc), '-t', 'coordinator', 'bash', '--norc'], {env});
        let tty;
        /* Control this fixture's display tty and private socket directory. */
        function cmd(...args) { return run(['screen', '-S', 'tree', ...args], {env, stdin: tty, check: true}).stdout; }
        /* Send a private display mutation. */
        function control(...args) { return cmd('-X', ...args); }
        /* Read one displayed window's dimensions. */
        function dimensions() { const info = cmd('-Q', 'info'), match = info.match(/\/\((\d+),(\d+)\)/); assert.ok(match, info); return match.slice(1).map(Number); }
        try {
            const display = pty.tty(); sleep(.15); tty = {fd: fs.openSync(display, 'r')};
            control('split'); control('resize', '-v', '53'); control('focus', 'down');
            control('screen', '-t', 'unrelated', 'bash', '--norc');
            const unrelatedBefore = dimensions();
            control('focus', 'top'); const before = dimensions();
            control('layout', 'save', 'original'); control('layout', 'autosave', 'off'); control('layout', 'save', 'working');
            const exact = fs.readdirSync(String(root)).find(name => name.endsWith('.tree')); assert.ok(exact);
            const serverPid = Number(exact.split('.')[0]);
            const childPid = fs.readFileSync(`/proc/${serverPid}/task/${serverPid}/children`, 'utf8').trim().split(/\s+/)[0];
            const windowTty = fs.readlinkSync(`/proc/${childPid}/fd/0`);
            const request = {driver: 'screen', context: {session: exact, socket_dir: String(root), window_tty: windowTty}, coordinator: '0', concurrency, run_id: 'fixture'+concurrency, cwd: String(root), record: String(root.join('layout.json'))};
            /* Invoke the production layout adapter with immutable request data. */
            function layout(action, extra = {}) {
                const input = root.join('input.json'); input.writeText(json({...request, ...extra}));
                const result = run([process.execPath, SCRIPTS.join('layout.js'), action, input], {env, timeout: 180});
                assert.equal(result.status, 0, result.stdout+result.stderr);
                console.log('ACTION', concurrency, action, 'PASS'); return JSON.parse(result.stdout).result;
            }
            cmd('-X', 'layout', 'number'); const layoutBefore = 'This is layout 1 (working).';
            const result = layout('create'); assert.equal(result.state, 'ready');
            assert.equal(layout('inspect').snapshot.focus, '0');
            layout('claim', {role: 'review', slot: 1, task_id: 'fixture', target_id: 'i10'});
            const role = root.join('role.json'); role.writeText(json({status: 'complete'}));
            layout('release', {placement: 'review:1', task_id: 'fixture', result_path: String(role), results_verified: true, descendants_stopped: true, worker_stopped: true});
            if (concurrency === 1) {
                const job = root.join('job.json'), exit = root.join('exit.json'), input = root.join('launch.json');
                job.writeText(json({argv: [process.execPath, '-e', 'console.log("owned screen worker");'], exit_record: String(exit)}));
                input.writeText(json({...request, role: 'master', slot: 1, task_id: 'master-launch', target_id: 'i10', job: String(job), layout_record: request.record}));
                const launched = run([process.execPath, SCRIPTS.join('screen.js'), 'launch', input], {env, timeout: 30});
                assert.equal(launched.status, 0, launched.stdout+launched.stderr);
                assert.equal(JSON.parse(launched.stdout).result.pane, result.resources['master:1'].id);
                for (let count = 0; count < 100 && !exit.exists(); count++) sleep(.01);
                assert.equal(JSON.parse(exit.readText()).exit_code, 0);
                layout('release', {placement: 'master:1', task_id: 'master-launch', result_path: String(role), results_verified: true, descendants_stopped: true, worker_stopped: true});
                console.log('SCREEN_LAUNCH_PASS');
            }
            layout('cleanup', {results_verified: true, descendants_stopped: true});
            const check = root.join('check.json'); check.writeText(json(JSON.parse(P(request.record).readText()).context));
            const code = 'const a=require(require("node:path").join(require("node:path").dirname(process.argv[1]),"layout-adapters/screen.js"));process.stdout.write(a.borkLayoutScreen(JSON.parse(require("node:fs").readFileSync(process.argv[2],"utf8")),["-X","layout","number"]));';
            const actual = run([process.execPath, '-e', code, SCRIPTS.join('layout.js'), check], {env, timeout: 15});
            assert.equal(actual.status, 0, actual.stderr); assert.equal(actual.stdout, layoutBefore);
            reports.push({concurrency, status: 'PASS', root: String(root)});
        } finally {
            try { if (tty) control('quit'); }
            finally { if (tty) fs.closeSync(tty.fd); pty.cleanup(); }
        }
    }
    const report = P(evidence.name).join('result.json'); report.writeText(json(reports, {indent: 2})+'\n');
    console.log('EVIDENCE', String(report));
}
if (require.main === module) main();
module.exports = {main};
