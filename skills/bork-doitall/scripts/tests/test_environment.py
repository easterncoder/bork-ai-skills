"""Environment selection fixtures and isolated live tmux membership checks."""

import itertools
import json
import os
import shutil
import shlex
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parents[1] / 'environment.php'
CAPACITY = {name: {'supported': True, 'evidence': 'Fixture host capacity verified'}
            for name in ('native', 'tmux', 'herdr')}
RUNNER = r'''
require $argv[1];
$x = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
try {
    $env = static fn ($key) => $x['env'][$key] ?? false;
    $run = static function ($args) use ($x) {
        $key = implode(' ', $args);
        if (!isset($x['commands'][$key])) { throw new RuntimeException('Unexpected discovery: ' . $key); }
        return $x['commands'][$key];
    };
    $ancestor = static fn ($pid) => in_array($pid, $x['ancestors'] ?? [], true);
    $contexts = detectEnvironment($env, $run, $ancestor, $x['expected_environment'] ?? null);
    echo json_encode(['ok' => true, 'result' => selectEnvironment($contexts, $x['capabilities'])]);
} catch (Throwable $error) {
    echo json_encode(['ok' => false, 'error' => $error->getMessage()]);
}
'''


class EnvironmentTests(unittest.TestCase):
    """Exercise actual selection and detection with injected read-only commands."""

    def fixture(self, herdr=False, tmux=False):
        """Build responses matching the installed Herdr 0.9.5 schema and tmux format."""
        data = {'env': {}, 'commands': {}, 'ancestors': [123], 'capabilities': CAPACITY}
        if herdr:
            data['env'].update(HERDR_ENV='1', HERDR_PANE_ID='w1:p2', HERDR_TAB_ID='w1:t1', HERDR_WORKSPACE_ID='w1', HERDR_SOCKET_PATH='/tmp/herdr.sock')
            data['commands']['herdr pane current --current'] = json.dumps({'id': '1', 'result': {'type': 'pane_current', 'pane': {'pane_id': 'w1:p2', 'tab_id': 'w1:t1', 'workspace_id': 'w1'}}})
            data['commands']['herdr pane process-info --current'] = json.dumps({'id': '2', 'result': {'type': 'pane_process_info', 'process_info': {'pane_id': 'w1:p2', 'shell_pid': 123}}})
        if tmux:
            data['env'].update(TMUX='/tmp/named,456,0', TMUX_PANE='%3')
            data['commands']['tmux -S /tmp/named display-message -p -t %3 #{pane_id}|#{pane_pid}|#{socket_path}|#{pid}|#{session_id}'] = '%3|123|/tmp/named|456|$0'
        return data

    def call(self, data):
        """Evaluate PHP functions directly without allowing a fixture CLI override."""
        result = subprocess.run(['php', '-r', RUNNER, str(HELPER)], input=json.dumps(data), text=True,
                                capture_output=True, check=True, timeout=10)
        return json.loads(result.stdout)

    def test_matrix_and_capability_never_reorders(self):
        """All memberships select deterministically, even with insufficient native capacity."""
        for herdr, tmux, native in itertools.product((False, True), repeat=3):
            data = self.fixture(herdr, tmux)
            data['capabilities'] = {**CAPACITY, 'native': {'supported': native, 'evidence': 'fixture', 'blocker': 'native slots missing'}}
            selected = 'herdr' if herdr else ('tmux' if tmux else 'native')
            result = self.call(data)
            self.assertEqual(result['ok'], selected != 'native' or native)
            if result['ok']:
                self.assertEqual(result['result']['execution_driver'], selected)
            else:
                self.assertIn('Selected driver native is blocked', result['error'])

    def test_installed_inactive_tools_are_never_probed(self):
        """No membership signal selects native without any terminal command."""
        self.assertEqual(self.call(self.fixture())['result']['execution_driver'], 'native')

    def test_invalid_explicit_context_blocks(self):
        """Partial, stale, non-ancestor and unreachable contexts cannot fall through."""
        for env in ({'HERDR_ENV': '0'}, {'HERDR_PANE_ID': 'w1:p2'}, {'TMUX': '/tmp/stale,1,0'}, {'TMUX_PANE': '%1'}):
            data = self.fixture()
            data['env'] = env
            self.assertFalse(self.call(data)['ok'])
        for herdr, tmux in ((True, False), (False, True), (True, True)):
            data = self.fixture(herdr, tmux)
            data['ancestors'] = []
            self.assertFalse(self.call(data)['ok'])
            data = self.fixture(herdr, tmux)
            data['commands'] = {}
            self.assertFalse(self.call(data)['ok'])

    def test_reported_membership_cannot_silently_select_another_driver(self):
        """Hidden caller context blocks even when a different driver has capacity."""
        for expected in ('herdr', 'tmux'):
            data = self.fixture(tmux=expected == 'herdr')
            data['expected_environment'] = expected
            result = self.call(data)
            self.assertFalse(result['ok'], result)
            self.assertIn('not visible to this tool process', result['error'])

    def test_reported_membership_still_requires_live_verification(self):
        """An expectation is a guard, never a substitute for membership evidence."""
        for expected in ('herdr', 'tmux'):
            data = self.fixture(herdr=expected == 'herdr', tmux=expected == 'tmux')
            data['expected_environment'] = expected
            result = self.call(data)
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['result']['execution_driver'], expected)
            data['ancestors'] = []
            self.assertFalse(self.call(data)['ok'])
        data = self.fixture()
        data['expected_environment'] = 'unknown'
        self.assertFalse(self.call(data)['ok'])

    def test_cli_reports_hidden_caller_context(self):
        """The public JSON interface preserves the expectation before selection."""
        env = {key: value for key, value in os.environ.items()
               if not key.startswith('HERDR_') and key not in ('TMUX', 'TMUX_PANE')}
        with tempfile.TemporaryDirectory(prefix='no-codex-frontend-') as directory:
            result = subprocess.run(['php', str(HELPER)],
                                    input=json.dumps({'expected_environment': 'herdr', 'capabilities': CAPACITY}),
                                    cwd=directory, env=env, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertIn('reported herdr caller', json.loads(result.stdout)['error'])

    def test_frontend_recovery_uses_unique_same_user_cwd_and_identity(self):
        """Recover only caller variables and reject competing or mismatched frontends."""
        runner = r'''
require $argv[1];
try {
    echo json_encode(['ok' => true, 'frontend' => recoverTerminalFrontend($argv[2], $argv[3], (int) $argv[4], $argv[5])]);
} catch (Throwable $error) {
    echo json_encode(['ok' => false, 'error' => $error->getMessage()]);
}
'''
        with tempfile.TemporaryDirectory(prefix='frontend-proc-') as directory:
            root = Path(directory)
            cwd = root / 'work'
            cwd.mkdir()
            executable = root / 'codex'
            executable.touch()

            def frontend(pid, args, env, working_directory=cwd):
                """Create only the procfs fields consumed by frontend recovery."""
                process = root / str(pid)
                process.mkdir()
                (process / 'exe').symlink_to(executable)
                (process / 'cwd').symlink_to(working_directory)
                (process / 'cmdline').write_bytes(b'\0'.join(arg.encode() for arg in args) + b'\0')
                (process / 'stat').write_text(f'{pid} (codex) ' + ' '.join(['S'] + ['0'] * 18 + ['12345']))
                (process / 'environ').write_bytes(b'\0'.join(f'{key}={value}'.encode() for key, value in env.items()))
                return process

            def recover(owner=os.getuid(), working_directory=cwd, expected='herdr'):
                """Call production recovery against an isolated process inventory."""
                result = subprocess.run(['php', '-r', runner, str(HELPER), str(root),
                                         str(working_directory), str(owner), expected], capture_output=True, text=True, check=True)
                return json.loads(result.stdout)

            context = self.fixture(herdr=True)['env']
            process = frontend(100, ['codex', 'resume', '--last'], {**context, 'SECRET': 'never-copy'})
            frontend(101, ['codex', 'app-server'], context)
            result = recover()
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['frontend'], {'pid': 100, 'start_time': '12345', 'environment': context})
            self.assertFalse(recover(owner=os.getuid() + 1)['ok'])
            self.assertFalse(recover(working_directory=root)['ok'])
            competitor = frontend(102, ['codex'], {})
            self.assertFalse(recover()['ok'])
            shutil.rmtree(competitor)
            (process / 'environ').write_bytes(b'HERDR_ENV=0')
            self.assertFalse(recover()['ok'])
            tmux_context = self.fixture(tmux=True)['env']
            (process / 'environ').write_bytes(b'\0'.join(f'{key}={value}'.encode() for key, value in tmux_context.items()))
            recovered = recover(expected='tmux')
            self.assertTrue(recovered['ok'], recovered)
            self.assertEqual(recovered['frontend']['environment'], tmux_context)
            self.assertFalse(recover()['ok'])

    def test_recovered_frontend_must_descend_from_the_pane_shell(self):
        """Detached backend ancestry is replaced only by the identified caller PID."""
        runner = r'''
require $argv[1];
$run = static fn ($args) => "900 100\n100 50\n50 1\n1 0";
echo json_encode([environmentAncestor(50, $run, 900), environmentAncestor(70, $run, 900)]);
'''
        result = subprocess.run(['php', '-r', runner, str(HELPER)], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), [True, False])

    def test_moved_herdr_caller_resolves_live_identity(self):
        """A moved caller retains its launch alias while current responses identify its live pane."""
        data = self.fixture(herdr=True)
        data['commands']['herdr pane current --current'] = json.dumps({'result': {'pane': {'pane_id': 'w2:p4', 'tab_id': 'w2:t3', 'workspace_id': 'w2'}}})
        data['commands']['herdr pane process-info --current'] = json.dumps({'result': {'process_info': {'pane_id': 'w2:p4', 'shell_pid': 123}}})
        result = self.call(data)
        self.assertTrue(result['ok'], result)
        context = result['result']['contexts']['herdr']
        self.assertEqual((context['pane_id'], context['tab_id'], context['workspace_id']), ('w2:p4', 'w2:t3', 'w2'))
        data['ancestors'] = []
        self.assertFalse(self.call(data)['ok'])
        data['ancestors'] = [123]
        data['commands']['herdr pane current --current'] = json.dumps({'result': {'pane': {'pane_id': '', 'tab_id': 'w2:t3', 'workspace_id': 'w2'}}})
        self.assertFalse(self.call(data)['ok'])
        data['commands']['herdr pane current --current'] = json.dumps({'result': {'pane': {'pane_id': 'w2:p4', 'tab_id': 'w2:t3', 'workspace_id': 'w2'}}})
        data['commands']['herdr pane process-info --current'] = json.dumps({'result': {'process_info': {'pane_id': 'w3:p9', 'shell_pid': 123}}})
        self.assertFalse(self.call(data)['ok'])

    def test_selected_driver_capability_blocks_without_fallback(self):
        """Native availability cannot rescue a selected terminal driver."""
        for driver in ('herdr', 'tmux'):
            data = self.fixture(driver == 'herdr', driver == 'tmux')
            data['capabilities'] = {**CAPACITY, driver: {'supported': False, 'blocker': 'required model unavailable'}}
            result = self.call(data)
            self.assertFalse(result['ok'])
            self.assertIn('required model unavailable', result['error'])

    @unittest.skipUnless(shutil.which('tmux') and shutil.which('cc') and Path('/proc/self').exists(),
                         'local procfs, tmux and a C compiler required')
    def test_detached_tmux_recovery_and_context_command(self):
        """A harmless frontend fixture proves recovery and socket routing outside its pane."""
        with tempfile.TemporaryDirectory(prefix='detached-tmux-') as directory:
            root = Path(directory)
            socket = str(root / 'socket')
            frontend = root / 'codex'
            source = root / 'frontend.c'
            source.write_text('#include <unistd.h>\n/* Keep the fixture alive for discovery. */\nint main(void) { sleep(30); return 0; }\n')
            subprocess.run(['cc', str(source), '-o', str(frontend)], check=True, capture_output=True)
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith('HERDR_') and key not in ('TMUX', 'TMUX_PANE')}
            env['CODEX_THREAD_ID'] = 'fixture-detached-thread'
            command = 'exec ' + shlex.quote(str(frontend))
            try:
                subprocess.run(['tmux', '-S', socket, 'new-session', '-d', '-s', 'fixture',
                                '-c', directory, command], env=env, check=True, capture_output=True)
                for _ in range(100):
                    pane_pid = subprocess.check_output(['tmux', '-S', socket, 'display-message', '-p',
                                                        '#{pane_pid}'], text=True).strip()
                    if Path(f'/proc/{pane_pid}/exe').resolve() == frontend:
                        break
                    time.sleep(.02)
                result = subprocess.run(['php', str(HELPER)], input=json.dumps({'capabilities': CAPACITY}),
                                        env=env, cwd=directory, text=True, capture_output=True, timeout=10)
                data = json.loads(result.stdout)
                self.assertTrue(data['ok'], data)
                self.assertEqual(data['result']['execution_driver'], 'tmux')
                context = data['result']['contexts']['tmux']
                self.assertEqual(context['socket'], socket)
                self.assertEqual(context['frontend']['pid'], int(pane_pid))
                output = subprocess.run(['php', str(HELPER), 'tmux', 'display-message', '-p', '#{socket_path}'],
                                        cwd=directory, env=env, text=True, capture_output=True, timeout=10)
                self.assertEqual(output.returncode, 0, output.stdout)
                self.assertEqual(output.stdout.strip(), socket)
            finally:
                subprocess.run(['tmux', '-S', socket, 'kill-server'], capture_output=True)

    @unittest.skipUnless(shutil.which('tmux') and shutil.which('ps'), 'tmux and ps required')
    def test_live_named_socket_and_stale_inheritance(self):
        """Only the process within the live named-server pane verifies membership."""
        with tempfile.TemporaryDirectory(prefix='environment-tmux-') as directory:
            root = Path(directory)
            socket = str(root / 'socket')
            output = root / 'output.json'
            inputs = root / 'capacity.json'
            inputs.write_text(json.dumps({'capabilities': CAPACITY}))
            command = shlex.join(['php', str(HELPER), str(inputs)]) + ' > ' + shlex.quote(str(output)) + '; sleep 3'
            base_env = {key: value for key, value in os.environ.items() if not key.startswith('HERDR_') and key not in ('TMUX', 'TMUX_PANE')}
            try:
                subprocess.run(['tmux', '-S', socket, 'new-session', '-d', '-s', 'probe', command], env=base_env, check=True, capture_output=True)
                for _ in range(100):
                    if output.exists() and output.stat().st_size:
                        break
                    time.sleep(.02)
                result = json.loads(output.read_text())
                self.assertTrue(result['ok'], result)
                self.assertEqual(result['result']['execution_driver'], 'tmux')
                context = result['result']['contexts']['tmux']
                stale_env = {**base_env, 'TMUX': socket + ',' + subprocess.check_output(['tmux', '-S', socket, 'display-message', '-p', '#{pid}'], text=True).strip() + ',0', 'TMUX_PANE': context['pane_id']}
                stale = subprocess.run(['php', str(HELPER), str(inputs)], env=stale_env, text=True, capture_output=True)
                self.assertEqual(stale.returncode, 1)
                self.assertIn('another process', json.loads(stale.stdout)['error'])
            finally:
                subprocess.run(['tmux', '-S', socket, 'kill-server'], capture_output=True)


if __name__ == '__main__':
    unittest.main()
