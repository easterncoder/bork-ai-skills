"""Isolated scheduler and real tmux tests; never run an AI CLI or contact GitHub."""

import os
import json
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parents[1] / 'tmux.js'


class DoitallTests(unittest.TestCase):
    """Exercise public JSON commands against disposable tmux sessions."""

    def setUp(self):
        """Prepare a private socket and temporary input directory."""
        self.temp = tempfile.TemporaryDirectory(prefix='doitall-test-')
        self.root = Path(self.temp.name)
        self.socket = self.root.name
        self.counter = 0

    def tearDown(self):
        """Stop only this test's isolated server and remove its files."""
        subprocess.run(['tmux', '-L', self.socket, 'kill-server'], capture_output=True)
        self.temp.cleanup()

    def invoke(self, action, data):
        """Invoke a helper command with an immutable JSON input file."""
        self.counter += 1
        source = self.root / f'input-{self.counter}.json'
        source.write_text(json.dumps(data))
        result = subprocess.run([shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'), str(HELPER), action, str(source)], capture_output=True, text=True, timeout=15)
        output = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0 if output['ok'] else 1, result.stderr)
        return output

    def target(self, status='queued', parents=()):
        """Construct a normalized scheduling target."""
        return {'status': status, 'depends_on': list(parents)}

    def test_limit_includes_review_wait(self):
        """Two active targets allow one launch; three allow none."""
        targets = {'a': self.target('waiting_review'), 'b': self.target('running'), 'c': self.target()}
        self.assertEqual(self.invoke('schedule', {'targets': targets, 'max_concurrency': 3})['result']['launch'], ['c'])
        targets['c']['status'] = 'starting'
        self.assertEqual(self.invoke('schedule', {'targets': targets, 'max_concurrency': 3})['result']['launch'], [])

    def test_serial_default(self):
        """Default scheduling finishes one target before selecting the next."""
        targets = {'a': self.target(), 'b': self.target()}
        self.assertEqual(self.invoke('schedule', {'targets': targets})['result']['launch'], ['a'])
        for status in ['starting', 'running', 'waiting_review']:
            targets['a']['status'] = status
            self.assertEqual(self.invoke('schedule', {'targets': targets})['result']['launch'], [])
        targets['a']['status'] = 'complete'
        self.assertEqual(self.invoke('schedule', {'targets': targets})['result']['launch'], ['b'])

    def test_explicit_limit_and_reduction(self):
        """Explicit parallelism respects capacity and lets active work drain."""
        targets = {'a': self.target(), 'b': self.target(), 'c': self.target()}
        self.assertEqual(self.invoke('schedule', {'targets': targets, 'max_concurrency': 2})['result']['launch'], ['a', 'b'])
        targets['a']['status'] = 'running'
        targets['b']['status'] = 'waiting_review'
        self.assertEqual(self.invoke('schedule', {'targets': targets, 'max_concurrency': 1})['result']['launch'], [])

    def test_invalid_concurrency(self):
        """Reject unsupported concurrency values."""
        for limit in [0, 4, -1, '2', True, 1.5]:
            with self.subTest(limit=limit):
                self.assertFalse(self.invoke('schedule', {'targets': {}, 'max_concurrency': limit})['ok'])

    def test_dependency_requires_complete(self):
        """Blocked or merely running parents never release a child."""
        targets = {'parent': self.target('blocked'), 'child': self.target(parents=['parent']), 'other': self.target()}
        blocked = self.invoke('schedule', {'targets': targets})['result']
        self.assertEqual(blocked['launch'], ['other'])
        self.assertEqual(blocked['blocked'], {'child': {'reason': 'dependency_blocked', 'dependency': 'parent'}})
        targets['parent']['status'] = 'complete'
        self.assertEqual(self.invoke('schedule', {'targets': targets})['result']['launch'], ['child'])

    def test_transitive_block_and_cycle(self):
        """Report cycle members and downstream targets while independent work proceeds."""
        targets = {
            'a': self.target(parents=['b']),
            'b': self.target(parents=['a']),
            'downstream': self.target(parents=['a']),
            'skipped': self.target('skipped'),
            'blocked_by_skip': self.target(parents=['skipped']),
            'independent': self.target(),
        }
        result = self.invoke('schedule', {'targets': targets})['result']
        self.assertEqual(result['launch'], ['independent'])
        self.assertEqual(result['waiting'], [])
        self.assertEqual(result['blocked']['a']['reason'], 'dependency_cycle')
        self.assertEqual(result['blocked']['b']['reason'], 'dependency_cycle')
        self.assertEqual(set(result['blocked']['a']['cycle']), {'a', 'b'})
        self.assertEqual(result['blocked']['downstream'], {'reason': 'dependency_blocked', 'dependency': 'a'})
        self.assertEqual(result['blocked']['blocked_by_skip'], {'reason': 'dependency_blocked', 'dependency': 'skipped'})

    def test_waiting_on_active_parent_is_not_blocked(self):
        """An active prerequisite remains a legitimate wait."""
        targets = {'parent': self.target('running'), 'child': self.target(parents=['parent'])}
        result = self.invoke('schedule', {'targets': targets})['result']
        self.assertEqual(result['waiting'], ['child'])
        self.assertEqual(result['blocked'], {})

    def test_unknown_dependency_rejected(self):
        """Malformed plans cannot silently ignore prerequisites."""
        self.assertFalse(self.invoke('schedule', {'targets': {'x': self.target(parents=['missing'])}})['ok'])

    def test_discovered_targets_can_expand_batch(self):
        """A target queue may exceed three entries while concurrency stays capped."""
        targets = {str(i): self.target() for i in range(7)}
        result = self.invoke('schedule', {'targets': targets, 'max_concurrency': 3})
        self.assertTrue(result['ok'])
        self.assertEqual(result['result']['launch'], ['0', '1', '2'])
        self.assertEqual(result['result']['waiting'], ['3', '4', '5', '6'])

    def launch(self, role='master', session='doitall-fixture', socket_path=None):
        """Launch a harmless Node.js process in place of a master AI."""
        suffix = str(self.counter + 1)
        record = self.root / f'exit-{suffix}.json'
        job = self.root / f'job-{suffix}.json'
        job.write_text(json.dumps({'argv': [shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'), '-e', 'console.log("visible fixture");'], 'exit_record': str(record)}))
        data = {'role': role, 'cwd': str(self.root), 'job': str(job), 'socket': self.socket}
        if socket_path is not None:
            del data['socket']
            data['socket_path'] = socket_path
        data['session_name'] = session
        return self.invoke('launch', data), record

    @unittest.skipUnless(shutil.which('tmux'), 'tmux unavailable')
    def test_absolute_socket_preserves_selected_server(self):
        """Launch on the inherited absolute socket rather than a default server."""
        socket = str(self.root / 'selected.sock')
        try:
            result, _ = self.launch(socket_path=socket)
            self.assertTrue(result['ok'], result)
            role = subprocess.check_output(['tmux', '-S', socket, 'display-message', '-p',
                                            '-t', result['result']['pane'], '#{@bork-role}'], text=True).strip()
            self.assertEqual(role, 'master')
        finally:
            subprocess.run(['tmux', '-S', socket, 'kill-server'], capture_output=True)

    def test_unmanaged_roles_rejected(self):
        """Only target masters and coordinated workers receive sessions."""
        for role in ('prify', 'goodcode', 'unknown'):
            with self.subTest(role=role):
                result, _ = self.launch(role)
                self.assertFalse(result['ok'])
                self.assertIn('Only master, review or fix sessions', result['error'])

    @unittest.skipUnless(shutil.which('tmux'), 'tmux unavailable')
    def test_goodcode_workers_have_separate_sessions(self):
        """Review and fix can run concurrently under their own role identities."""
        for role in ('review', 'fix'):
            result, _ = self.launch(role=role, session=f'fixture-{role}')
            self.assertTrue(result['ok'], result)
            actual = subprocess.check_output([
                'tmux', '-L', self.socket, 'display-message', '-p',
                '-t', result['result']['pane'], '#{@bork-role}',
            ], text=True).strip()
            self.assertEqual(actual, role)

    @unittest.skipUnless(shutil.which('tmux'), 'tmux unavailable')
    def test_separate_master_sessions(self):
        """Independent targets get independent single-pane sessions."""
        first, _ = self.launch(session='doitall-fixture')
        second, _ = self.launch(session='doitall-second')
        self.assertTrue(first['ok'], first)
        self.assertTrue(second['ok'], second)
        self.assertNotEqual(first['result']['pane'], second['result']['pane'])
        for session in ('doitall-fixture', 'doitall-second'):
            lines = subprocess.check_output([
                'tmux', '-L', self.socket, 'list-panes', '-t', session,
                '-F', '#{@bork-role} #{pane_left}',
            ], text=True).splitlines()
            self.assertEqual(lines, ['master 0'])

    @unittest.skipUnless(shutil.which('tmux'), 'tmux unavailable')
    def test_master_retains_output_and_result(self):
        """The master stays inspectable with separate process evidence."""
        result, master_record = self.launch()
        self.assertTrue(result['ok'], result)
        master = result['result']['pane']
        deadline = time.monotonic() + 5
        while not master_record.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(json.loads(master_record.read_text())['exit_code'], 0)
        lines = subprocess.check_output([
            'tmux', '-L', self.socket, 'list-panes', '-t', 'doitall-fixture',
            '-F', '#{@bork-role}:#{pane_dead}',
        ], text=True).splitlines()
        self.assertEqual(lines, ['master:1'])
        output = subprocess.check_output(['tmux', '-L', self.socket, 'capture-pane', '-p', '-S', '-1000', '-t', master], text=True)
        self.assertIn('visible fixture', output)


if __name__ == '__main__':
    unittest.main()
