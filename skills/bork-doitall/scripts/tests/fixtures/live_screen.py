"""Opt-in isolated installed-host acceptance fixture retaining review evidence."""
from pathlib import Path
SCRIPTS = Path(__file__).resolve().parents[2]
import threading, select
import os, pty, fcntl, termios, struct, subprocess, tempfile, time, re, json
report_path = str(Path(tempfile.mkdtemp(prefix='bork-screen-adapter-')) / 'result.json')
reports = []
for concurrency in [1, 2, 3]:
    root = tempfile.mkdtemp(prefix='screen-tree-research-')
    os.chmod(root, 448)
    env = dict(os.environ, SCREENDIR=root, TERM='xterm-256color')
    env.pop('STY', None)
    rc = root + '/rc'
    open(rc, 'w').write('startup_message off\nmsgwait 0\ncaption always "%n %t"\n')
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 64, 200, 0, 0))
        os.execvpe('screen', ['screen', '-m', '-S', 'tree', '-c', rc, '-t', 'coordinator', 'bash', '--norc'], env)
    time.sleep(0.15)

    os.set_blocking(fd, False)
    drain_stop = threading.Event()

    def drain(owned_fd=fd):
        """Consume private display output as a normal attached renderer would."""
        while not drain_stop.is_set():
            try:
                if select.select([owned_fd], [], [], 0.1)[0]:
                    if not os.read(owned_fd, 65536):
                        return
            except BlockingIOError:
                continue
            except OSError:
                return
    drain_thread = threading.Thread(target=drain, daemon=True)
    drain_thread.start()
    tty = os.readlink('/proc/' + str(pid) + '/fd/0')
    ttyfile = open(tty, 'rb', buffering=0)

    def cmd(*args):
        """Control only this fixture session through its exact display tty."""
        p = subprocess.run(['screen', '-S', 'tree', *args], env=env, stdin=ttyfile, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=10)
        assert p.returncode == 0, (args, p.stdout)
        return p.stdout

    def x(*args):
        """Send one fixture setup control."""
        return cmd('-X', *args)

    def q(*args):
        """Read one fixture display query."""
        return cmd('-Q', *args)

    def dims():
        """Read the uniquely displayed fixture window dimensions."""
        m = re.search('/\\((\\d+),(\\d+)\\)', q('info'))
        assert m, q('info')
        return tuple(map(int, m.groups()))
    roles = ['coordinator', 'unrelated']

    def focus(role):
        """Focus the fixture role in traversal order."""
        x('focus', 'top')
        for _ in range(roles.index(role)):
            x('focus', 'next')
    try:
        x('split')
        x('resize', '-v', '53')
        x('focus', 'down')
        x('screen', '-t', 'unrelated', 'bash', '--norc')
        unrelated_before = dims()
        focus('coordinator')
        before = dims()
        x('layout', 'save', 'original')
        x('layout', 'autosave', 'off')
        x('layout', 'save', 'working')
        exact = next((f for f in os.listdir(root) if f.endswith('.tree')))
        serverpid = int(exact.split('.')[0])
        childpid = open('/proc/' + str(serverpid) + '/task/' + str(serverpid) + '/children').read().split()[0]
        windowtty = os.readlink('/proc/' + childpid + '/fd/0')
        request = {'driver': 'screen', 'context': {'session': exact, 'socket_dir': root, 'window_tty': windowtty}, 'coordinator': '0', 'concurrency': concurrency, 'run_id': 'fixture' + str(concurrency), 'cwd': root, 'record': root + '/layout.json'}

        def layout(action, extra=None):
            """Invoke the actual layout helper with a new immutable request."""
            data = dict(request)
            data.update(extra or {})
            ip = root + '/input.json'
            open(ip, 'w').write(json.dumps(data))
            p = subprocess.run(['php', str(SCRIPTS / 'layout.php'), action, ip], env=env, text=True, capture_output=True, timeout=180)
            print('ACTION', concurrency, action, p.returncode, p.stdout if p.returncode else 'PASS', flush=True)
            assert p.returncode == 0, p.stdout + p.stderr
            return json.loads(p.stdout)['result']
        layout_before = cmd('-X', 'layout', 'number')
        layout_before = 'This is layout 1 (working).'
        result = layout('create')
        assert result['state'] == 'ready'
        inspection = layout('inspect')
        assert inspection['snapshot']['focus'] == '0'
        layout('claim', {'role': 'review', 'slot': 1, 'task_id': 'fixture', 'target_id': 'i10'})
        rp = root + '/role.json'
        open(rp, 'w').write(json.dumps({'status': 'complete'}))
        layout('release', {'placement': 'review:1', 'task_id': 'fixture', 'result_path': rp, 'results_verified': True, 'descendants_stopped': True, 'worker_stopped': True})
        if concurrency == 1:
            job = root + '/job.json'
            exitfile = root + '/exit.json'
            open(job, 'w').write(json.dumps({'argv': ['/usr/bin/php', '-r', 'echo "owned screen worker\\n";'], 'exit_record': exitfile}))
            launch = dict(request, role='master', slot=1, task_id='master-launch', target_id='i10', job=job, layout_record=request['record'])
            lp = root + '/launch.json'
            open(lp, 'w').write(json.dumps(launch))
            launched = subprocess.run(['php', str(SCRIPTS / 'screen.php'), 'launch', lp], env=env, text=True, capture_output=True, timeout=30)
            assert launched.returncode == 0, launched.stdout + launched.stderr
            assert json.loads(launched.stdout)['result']['pane'] == result['resources']['master:1']['id']
            for _ in range(100):
                if os.path.exists(exitfile):
                    break
                time.sleep(0.01)
            assert json.load(open(exitfile))['exit_code'] == 0
            layout('release', {'placement': 'master:1', 'task_id': 'master-launch', 'result_path': rp, 'results_verified': True, 'descendants_stopped': True, 'worker_stopped': True})
            print('SCREEN_LAUNCH_PASS', flush=True)
        layout('cleanup', {'results_verified': True, 'descendants_stopped': True})
        ctx = json.load(open(request['record']))['context']
        check = root + '/check.json'
        open(check, 'w').write(json.dumps(ctx))
        v = subprocess.run(['php', '-r', 'require $argv[1]; echo borkLayoutScreen(json_decode(file_get_contents($argv[2]),true),["-X","layout","number"]);', str(SCRIPTS / 'layout.php'), check], env=env, text=True, capture_output=True, timeout=15)
        assert v.returncode == 0 and v.stdout == layout_before, (layout_before, v.stdout, v.stderr)
        reports.append({'concurrency': concurrency, 'status': 'PASS', 'root': root})
    finally:
        try:
            x('quit')
        finally:
            drain_stop.set()
            drain_thread.join(timeout=1)
            assert not drain_thread.is_alive(), 'Private display reader did not stop'
            ttyfile.close()
            os.close(fd)
            os.waitpid(pid, 0)
open(report_path, 'w').write(json.dumps(reports, indent=2) + '\n')
print('EVIDENCE', report_path, flush=True)
