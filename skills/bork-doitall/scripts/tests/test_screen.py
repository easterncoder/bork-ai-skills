"""Real GNU Screen lifecycle and caller-context checks using harmless local jobs."""

import itertools
import json
import os
import pty
import select
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which('screen') and Path('/proc/self').exists(), 'GNU Screen and procfs required')
class ScreenTests(unittest.TestCase):
    """Exercise isolated sessions without running an AI or contacting GitHub."""

    def setUp(self):
        """Allocate a private socket directory and clear inherited terminal identities."""
        self.temp = tempfile.TemporaryDirectory(prefix='screen-test-')
        self.root = Path(self.temp.name)
        self.sockets = self.root / 'sockets'
        self.sockets.mkdir(mode=0o700)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith('HERDR_') and key not in ('TMUX', 'TMUX_PANE', 'STY', 'WINDOW', 'CODEX_THREAD_ID')}
        self.env['SCREENDIR'] = str(self.sockets)
        self.identity = None
        self.counter = 0

    def tearDown(self):
        """Close only sessions inside the fixture's private socket directory."""
        for socket in self.sockets.iterdir():
            subprocess.run(['screen', '-S', socket.name, '-X', 'quit'], env=self.env, capture_output=True)
        self.temp.cleanup()

    def invoke(self, mode, data):
        """Call the public launcher with a fresh immutable input file."""
        self.counter += 1
        source = self.root / f'input-{self.counter}.json'
        source.write_text(json.dumps(data))
        result = subprocess.run([shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'), str(SCRIPTS / 'screen.js'), mode, str(source)],
                                env=self.env, text=True, capture_output=True, timeout=10)
        return json.loads(result.stdout)

    def launch(self, code='console.log("visible fixture");', role='master', name='fixture'):
        """Prepare and launch a harmless Node.js job through the shared runner."""
        record = self.root / f'exit-{name}.json'
        job = self.root / f'job-{name}.json'
        job.write_text(json.dumps({'argv': [shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'), '-e', code], 'exit_record': str(record)}))
        data = {'role': role, 'cwd': str(self.root), 'job': str(job), 'session_name': name,
                'socket_dir': str(self.sockets)}
        result = self.invoke('launch', data)
        if result['ok']:
            self.identity = result['result']
        return result, record

    def wait_record(self, record):
        """Wait briefly for atomic process exit evidence."""
        for _ in range(100):
            if record.exists():
                return json.loads(record.read_text())
            time.sleep(.02)
        self.fail('Exit record was not published')

    def test_selection_priority_capacity_and_legacy_records(self):
        """Screen follows active tmux and blocks capacity failure without fallback."""
        runner = r'''
const {selectEnvironment,validateEnvironmentSelection}=require(process.argv[1]);
const x=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
try {const selection=selectEnvironment(x.contexts,x.capabilities);validateEnvironmentSelection({execution_driver:selection.execution_driver,environment_selection:selection});console.log(require(require("node:path").resolve(require("node:path").dirname(process.argv[1]), "../../bork-review/scripts/support.js")).json_encode({ok:true,driver:selection.execution_driver}));}
catch(error){console.log(require(require("node:path").resolve(require("node:path").dirname(process.argv[1]), "../../bork-review/scripts/support.js")).json_encode({ok:false,error:error.message}));}

'''
        for herdr, tmux, screen in itertools.product((False, True), repeat=3):
            contexts = {name: {'active': active, 'pane_id': '0', 'socket': '123.fixture', 'shell_pid': 123}
                        for name, active in zip(('herdr', 'tmux', 'screen'), (herdr, tmux, screen))}
            selected = 'herdr' if herdr else 'tmux' if tmux else 'screen' if screen else 'native'
            for supported in (True, False):
                payload = {'contexts': contexts, 'capabilities': {selected: {'supported': supported, 'evidence': 'fixture'}}}
                output = subprocess.check_output([shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'), '-e', runner, str(SCRIPTS / 'environment.js')],
                                                 input=json.dumps(payload), text=True, env=self.env)
                result = json.loads(output)
                self.assertEqual(result['ok'], supported, result)
                if supported:
                    self.assertEqual(result['driver'], selected)

    def test_read_query_retries_after_owned_timeout(self):
        """A hung read query can be retried without replaying a mutation."""
        binary = self.root / 'bin'
        binary.mkdir()
        fake = binary / 'screen'
        count = self.root / 'calls'
        fake.write_text('''#!/usr/bin/python3
import os, pathlib, time
path = pathlib.Path(os.environ['SCREEN_CALLS'])
calls = int(path.read_text()) + 1 if path.exists() else 1
path.write_text(str(calls))
if calls == 1:
    time.sleep(6)
print("Remove dead screens with 'screen -wipe'." * 2)
print('0 (coordinator)')
''')
        fake.chmod(0o700)
        master, slave = pty.openpty()
        try:
            context = {'session': '123.fixture', 'window_tty': os.ttyname(slave)}
            script = ('const screen=require(process.argv[1]);'
                      'process.stdout.write(screen.borkLayoutScreen('
                      'JSON.parse(process.argv[2]),JSON.parse(process.argv[3])));')
            for args in (['-Q', 'number'], ['-p', '0', '-Q', 'title']):
                count.unlink(missing_ok=True)
                result = subprocess.run([shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'),
                                         '-e', script, str(SCRIPTS / 'layout-adapters/screen.js'),
                                         json.dumps(context), json.dumps(args)],
                                        env={**self.env, 'PATH': str(binary) + os.pathsep + self.env['PATH'],
                                             'SCREEN_CALLS': str(count)}, text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, '0 (coordinator)')
                self.assertEqual(count.read_text(), '2')
        finally:
            os.close(master)
            os.close(slave)

    def test_context_discovers_inherited_tty_without_environment(self):
        """An attached private Screen window supplies its stdin tty when TTY is unset."""
        output = self.root / 'tty-context.json'
        script = ('const fs=require("node:fs");const screen=require(process.argv[1]);'
                  'let result;try{result=screen.borkLayoutScreenContext('
                  '{session:process.env.STY,socket_dir:process.env.SCREENDIR},process.env.WINDOW);}'
                  'catch(error){result={error:error.message};}'
                  'fs.writeFileSync(process.argv[2],JSON.stringify(result));')
        env = {**self.env, 'TERM': 'xterm-256color'}
        env.pop('TTY', None)
        pid, display = pty.fork()
        if pid == 0:
            os.execvpe('screen', ['screen', '-m', '-S', 'ttycontext',
                                  shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'),
                                  '-e', script, str(SCRIPTS / 'layout-adapters/screen.js'), str(output)], env)
        try:
            deadline = time.monotonic() + 20
            while not output.exists() and time.monotonic() < deadline:
                if select.select([display], [], [], .1)[0]:
                    try:
                        os.read(display, 65536)
                    except OSError:
                        break
            self.assertTrue(output.exists(), 'Private Screen context probe did not finish')
            context = json.loads(output.read_text())
            self.assertNotIn('error', context)
            self.assertTrue(context['window_tty'].startswith('/dev/pts/'))
            self.assertTrue(context['display_tty'].startswith('/dev/pts/'))
        finally:
            subprocess.run(['screen', '-S', 'ttycontext', '-X', 'quit'], env=env, capture_output=True, timeout=5)
            os.close(display)
            os.waitpid(pid, 0)

    @unittest.skipUnless(shutil.which('cc'), 'C compiler required')
    def test_detached_frontend_recovery_and_context_command(self):
        """Recover Screen context for a unique frontend and route later queries."""
        source = self.root / 'frontend.c'
        frontend = self.root / 'codex'
        source.write_text('#include <unistd.h>\n/* Retain a harmless interactive fixture. */\nint main(void) { sleep(30); return 0; }\n')
        subprocess.run(['cc', str(source), '-o', str(frontend)], check=True, capture_output=True)
        job = self.root / 'job.json'
        job.write_text(json.dumps({'argv': [str(frontend)], 'exit_record': str(self.root / 'exit.json')}))
        result = self.invoke('launch', {'role': 'master', 'cwd': str(self.root), 'job': str(job),
                                        'session_name': 'frontend', 'socket_dir': str(self.sockets)})
        self.assertTrue(result['ok'], result)
        env = {**self.env, 'CODEX_THREAD_ID': 'fixture'}
        for _ in range(100):
            output = subprocess.run([shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'), str(SCRIPTS / 'environment.js')], env=env, cwd=self.root,
                                    input=json.dumps({'expected_environment': 'screen', 'capabilities': {
                                        'screen': {'supported': True, 'evidence': 'fixture'}}}),
                                    text=True, capture_output=True, timeout=10)
            data = json.loads(output.stdout)
            if data['ok']:
                break
            time.sleep(.02)
        self.assertTrue(data['ok'], data)
        context = data['result']['contexts']['screen']
        self.assertEqual(context['socket_dir'], str(self.sockets))
        self.assertIn('frontend', context)
        command = subprocess.run([shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'), str(SCRIPTS / 'environment.js'), 'screen', '-Q', 'number'],
                                 cwd=self.root, env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(command.returncode, 0, command.stdout)
        self.assertTrue(command.stdout.startswith('0 ('), command.stdout)

    def test_roles_persistence_capture_and_cleanup(self):
        """Each role retains output and exit evidence until its owned session is closed."""
        for role in ('master', 'review', 'fix'):
            result, record = self.launch(role=role, name=role)
            self.assertTrue(result['ok'], result)
            identity = result['result']
            self.assertEqual(identity['role'], role)
            self.assertEqual(self.wait_record(record)['exit_code'], 0)
            self.assertTrue(self.invoke('inspect', identity)['ok'])
            output = self.root / f'{role}.txt'
            self.assertTrue(self.invoke('capture', {**identity, 'output': str(output)})['ok'])
            for _ in range(100):
                if output.exists():
                    break
                time.sleep(.02)
            self.assertIn('visible fixture', output.read_text())
            self.assertTrue(self.invoke('close', identity)['ok'])
            self.assertFalse(self.invoke('inspect', identity)['ok'])

    def test_invalid_role_collision_and_independent_sessions(self):
        """Reject unsupported roles and prevent duplicate names while preserving workers."""
        result, _ = self.launch(role='prify')
        self.assertFalse(result['ok'])
        first, _ = self.launch(name='review')
        self.assertTrue(first['ok'], first)
        duplicate, _ = self.launch(name='review')
        self.assertFalse(duplicate['ok'])
        second, _ = self.launch(name='fix')
        self.assertTrue(second['ok'], second)
        self.assertNotEqual(first['result']['session'], second['result']['session'])
        self.assertTrue(self.invoke('inspect', first['result'])['ok'])

    def test_interrupt_publishes_nonzero_exit(self):
        """Deliver terminal Ctrl-C and retain the interrupted job's exit evidence."""
        result, record = self.launch('console.log("ready"); setTimeout(()=>{},30000);')
        self.assertTrue(result['ok'], result)
        time.sleep(.15)
        self.assertTrue(self.invoke('interrupt', self.identity)['ok'])
        self.assertNotEqual(self.wait_record(record)['exit_code'], 0)

    def test_live_membership_and_copied_context(self):
        """Accept the actual Screen child and reject copied or stale window identities."""
        output = self.root / 'membership.json'
        input_path = self.root / 'capacity.json'
        input_path.write_text(json.dumps({'expected_environment': 'screen', 'capabilities': {
            'screen': {'supported': True, 'evidence': 'fixture capacity'}}}))
        code = ('const fs=require("node:fs");const fd=fs.openSync(' + json.dumps(str(output))
                + ',"w"); require("node:child_process").spawnSync(' + json.dumps(shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'))
                + ',' + json.dumps([str(SCRIPTS / 'environment.js'), str(input_path)])
                + ',{stdio:["ignore",fd,"inherit"]});fs.closeSync(fd);setTimeout(()=>{},10000);')
        result, _ = self.launch(code)
        self.assertTrue(result['ok'], result)
        for _ in range(100):
            if output.exists() and output.stat().st_size:
                break
            time.sleep(.02)
        membership = json.loads(output.read_text())
        self.assertTrue(membership['ok'], membership)
        self.assertEqual(membership['result']['execution_driver'], 'screen')
        env = {**self.env, 'STY': self.identity['session'], 'WINDOW': '0'}
        copied = subprocess.run([shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'), str(SCRIPTS / 'environment.js'), str(input_path)],
                                env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(copied.returncode, 1)
        self.assertIn('another process', json.loads(copied.stdout)['error'])


if __name__ == '__main__':
    unittest.main()
