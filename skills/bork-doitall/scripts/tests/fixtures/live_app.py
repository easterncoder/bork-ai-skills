"""Opt-in isolated installed-host acceptance fixture retaining review evidence."""
from pathlib import Path
SCRIPTS = Path(__file__).resolve().parents[2]
import os
import shutil
import os, subprocess, tempfile, json, time, signal
root = tempfile.mkdtemp(prefix='bork-app-probe-', dir='/tmp')
private_session = 'bork-app-probe-' + str(os.getpid())
env = os.environ.copy()
env.update(HERDR_APP_HOME=root + '/home', XDG_STATE_HOME=root + '/state', HC_SESSION=private_session, HERDR_APP_NO_SOUND='1', WAYLAND_DISPLAY='')
env.pop('HC_TERMINAL_ID', None)
x = None
app = None
owned_core = None

def command(args, check=True):
    """Run an argument vector against the private fixture endpoints."""
    r = subprocess.run(args, env=env, text=True, capture_output=True, timeout=10)
    if check and r.returncode:
        raise RuntimeError(str(args) + r.stdout + r.stderr)
    return r

def rpc(method, params=None):
    """Send one public JSON-RPC request to the explicitly private core."""
    payload = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or {}}) + '\n'
    r = subprocess.run(['hc', 'connect', '--session', private_session], input=payload, env=env, text=True, capture_output=True, timeout=10)
    if r.returncode:
        raise RuntimeError(r.stderr)
    v = json.loads(r.stdout)
    if 'error' in v:
        raise RuntimeError(str(v))
    return v['result']
try:
    fd, path = tempfile.mkstemp(dir=root)
    os.close(fd)
    with open(path, 'w') as d:
        x = subprocess.Popen(['Xvfb', '-displayfd', str(d.fileno()), '-screen', '0', '2000x1600x24', '-nolisten', 'tcp'], pass_fds=(d.fileno(),), stdout=open(root + '/x.log', 'w'), stderr=subprocess.STDOUT)
    for _ in range(30):
        if os.path.getsize(path):
            break
        time.sleep(0.1)
    env['DISPLAY'] = ':' + open(path).read().strip()
    os.makedirs(env['HERDR_APP_HOME'], exist_ok=True)
    open(env['HERDR_APP_HOME'] + '/window.json', 'w').write(json.dumps({'state': 'windowed', 'bounds': [0, 0, 1800, 1400]}))
    open(env['HERDR_APP_HOME'] + '/shared.json', 'w').write(json.dumps({'frame.welcomed': 'skipped'}))
    app = subprocess.Popen(['herdr-app'], env=env, stdout=open(root + '/app.log', 'w'), stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(100):
        r = command(['herdr-app', 'status'], False)
        if r.returncode == 0:
            break
        if app.poll() is not None:
            raise RuntimeError('App exited ' + open(root + '/app.log').read())
        time.sleep(0.1)
    print('ROOT', root, 'SESSION', private_session, 'DISPLAY', env['DISPLAY'], flush=True)
    owned_core = rpc('server.status')
    print('PRIVATE_CORE', owned_core, flush=True)
    assert owned_core['pid'] > 0
    print('STATUS', r.stdout, flush=True)
    command(['herdr-app', 'do', 'layout.switch', json.dumps({'name': 'terminals'})])
    command(['herdr-app', 'do', 'layout.switch', json.dumps({'name': 'main'})])
    command(['herdr-app', 'do', 'space.new', json.dumps({'name': 'bork-probe', 'folder': root, 'argv': ['/bin/sh']})])

    def wait_doc(predicate):
        """Wait boundedly for the fixture document to reflect a completed control."""
        for _ in range(100):
            d = rpc('doc.get', {'name': 'herdr-app'})
            if d['value'] and predicate(d['value']):
                return d
            time.sleep(0.05)
        raise RuntimeError('doc persistence timeout')
    doc = wait_doc(lambda v: len(v['spaces']) == 1)
    fixture = doc['value']['spaces'][0]['tabs'][0]
    tab = fixture['id']
    pane = fixture['root']['children'][0]['id']
    coordinator = fixture['root']['children'][0]['content']['terminal']
    command(['herdr-app', 'do', 'tab.new', json.dumps({'name': 'unrelated', 'argv': ['/bin/sh']})])
    doc = wait_doc(lambda v: len(v['spaces'][0]['tabs']) == 2)
    unrelated = doc['value']['spaces'][0]['tabs'][1]
    command(['herdr-app', 'do', 'pane.focus', json.dumps({'pane': pane})])
    time.sleep(0.3)
    original = rpc('terminal.get', {'terminal': coordinator})
    print('ORIGINAL_DIMENSIONS', original['cols'], original['rows'], flush=True)

    def leaves(n):
        """Flatten the public split tree in display order."""
        return [n] if n['type'] == 'block' else [x for c in n.get('children', []) for x in leaves(c)]
    summary = []
    for concurrency in (1, 2, 3):
        request = {'driver': 'hc', 'visual_host': 'herdr-app', 'context': {'session': private_session, 'app_home': env['HERDR_APP_HOME']}, 'coordinator': pane, 'concurrency': concurrency, 'run_id': 'adapter' + str(concurrency), 'cwd': root, 'record': root + '/layout-' + str(concurrency) + '.json'}

        def layout(action, extra=None, success=True):
            """Invoke the actual layout helper with a new immutable request."""
            data = dict(request)
            data.update(extra or {})
            ip = root + '/input.json'
            open(ip, 'w').write(json.dumps(data))
            r = command([shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'), str(SCRIPTS / 'layout.js'), action, ip], False)
            print('ACTION', concurrency, action, r.returncode, r.stdout, flush=True) if r.returncode else print('ACTION', concurrency, action, 'PASS', flush=True)
            if success:
                assert r.returncode == 0, r.stdout
            return json.loads(r.stdout)
        result = layout('create')['result']
        assert result['state'] == 'ready'
        inspection = layout('inspect')['result']
        assert inspection['snapshot']['focus'] == pane
        claimed = layout('claim', {'role': 'review', 'slot': 1, 'task_id': 'fixture', 'target_id': 'i10'})['result']
        assert claimed['id'] == result['resources']['review:1']['id']
        layout('claim', {'role': 'review', 'slot': 1, 'task_id': 'duplicate', 'target_id': 'i10'}, False)
        resultfile = root + '/role-result.json'
        open(resultfile, 'w').write(json.dumps({'status': 'complete'}))
        layout('release', {'placement': 'review:1', 'task_id': 'fixture', 'result_path': resultfile, 'results_verified': True, 'descendants_stopped': True, 'worker_stopped': True})
        if concurrency == 1:
            job = root + '/worker-job.json'
            open(job, 'w').write(json.dumps({'argv': [shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'), '-e', 'console.log("visible worker"); setTimeout(()=>{},30000);'], 'exit_record': root + '/worker-exit.json'}))
            launch = {'record': root + '/hc-worker.json', 'job': job, 'cwd': root, 'name': 'fixture-worker', 'role': 'master', 'slot': 1, 'run_id': 'adapter1', 'task_id': 'master-live', 'target_id': 'i10', 'session': private_session, 'layout_record': request['record']}

            def lifecycle(action, data):
                """Exercise the actual hc lifecycle helper on its owned worker."""
                ip = root + '/hc-input.json'
                open(ip, 'w').write(json.dumps(data))
                r = command([shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'), str(SCRIPTS / 'hc.js'), action, ip], False)
                print('HC', action, r.returncode, r.stdout if r.returncode else 'PASS', flush=True)
                assert r.returncode == 0, r.stdout
                return json.loads(r.stdout)['result']
            worker = lifecycle('launch', launch)
            time.sleep(0.3)
            geometry = rpc('terminal.get', {'terminal': worker['terminal_id']})
            assert geometry['cols'] >= 35 and geometry['rows'] >= 6, geometry
            lifecycle('inspect', {'record': launch['record']})
            command(['herdr-app', 'shot', root + '/worker-visible.png'])
            os.killpg(app.pid, signal.SIGTERM)
            app.wait(timeout=5)
            app = subprocess.Popen(['herdr-app'], env=env, stdout=open(root + '/app-restarted.log', 'w'), stderr=subprocess.STDOUT, start_new_session=True)
            for _ in range(100):
                r = command(['herdr-app', 'status'], False)
                if r.returncode == 0:
                    break
                time.sleep(0.05)
            lifecycle('reconcile', {'record': launch['record']})
            stopped = lifecycle('cleanup', {'record': launch['record'], 'results_verified': True, 'descendants_stopped': True})
            assert stopped['state'] == 'removed'
            layout('release', {'placement': 'master:1', 'task_id': 'master-live', 'result_path': resultfile, 'results_verified': True, 'descendants_stopped': True, 'worker_stopped': True})
        time.sleep(0.2)
        status = json.loads(command(['herdr-app', 'status']).stdout)
        assert status['focused_pane'] == pane and status['errors'] == [] and (status['overlays'] == [])
        command(['herdr-app', 'shot', root + '/adapter-' + str(concurrency) + '.png'])
        layout('cleanup', {'results_verified': True, 'descendants_stopped': True})
        doc = wait_doc(lambda v: len(leaves(next((t for t in v['spaces'][0]['tabs'] if t['id'] == tab))['root'])) == 1)
        assert next((t for t in doc['value']['spaces'][0]['tabs'] if t['id'] == unrelated['id'])) == unrelated
        summary.append({'concurrency': concurrency, 'status': 'PASS', 'record': request['record']})
    open(root + '/summary.json', 'w').write(json.dumps(summary, indent=2))
finally:
    if app and app.poll() is None:
        os.killpg(app.pid, signal.SIGTERM)
        try:
            app.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(app.pid, signal.SIGKILL)
            app.wait()
    if owned_core:
        latest = rpc('server.status')
        procenv = open('/proc/' + str(latest['pid']) + '/environ', 'rb').read().split(b'\x00')
        assert latest['core']['id'] == owned_core['core']['id'] and latest['pid'] == owned_core['pid']
        assert ('HC_SESSION=' + private_session).encode() in procenv
        print('STOP_PRIVATE_CORE', rpc('server.stop'), flush=True)
    if x and x.poll() is None:
        x.terminate()
        x.wait(timeout=5)
    print('CLEANED', root, flush=True)
