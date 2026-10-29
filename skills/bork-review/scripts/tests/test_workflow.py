"""Run isolated CLI behavior checks with Python 3, Node.js and Git; no network access."""

import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[1] / 'workflow.js'


class WorkflowTests(unittest.TestCase):
    """Verify observable helper behavior in disposable repositories."""

    def setUp(self):
        """Create an isolated repository and suppress external Git configuration."""
        self.temp = tempfile.TemporaryDirectory(prefix='bork-runtime-test-')
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.empty_config = self.root / 'gitconfig'
        self.empty_config.write_text('')
        self.env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=str(self.empty_config))
        self.git('init', '-b', 'main', str(self.repo), cwd=self.root)
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'developer@example.test')
        self.git('config', 'commit.gpgsign', 'false')
        (self.repo / 'source.txt').write_text('initial\n')
        self.git('add', '.')
        self.git('commit', '-m', 'test: fixture')
        self.head = self.git('rev-parse', 'HEAD').strip()

    def tearDown(self):
        """Remove the disposable fixture."""
        self.temp.cleanup()

    def git(self, *args, cwd=None):
        """Run Git without a shell in the isolated environment."""
        return subprocess.check_output(['git', *args], cwd=cwd or self.repo, env=self.env, stderr=subprocess.DEVNULL, text=True)

    def call(self, action, **fields):
        """Invoke the public JSON interface and verify its exit status contract."""
        result = subprocess.run([shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'), str(HELPER)], input=json.dumps(dict(action=action, **fields)), text=True, capture_output=True, env=self.env, timeout=10)
        output = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0 if output['ok'] else 1, result.stderr)
        return output

    def test_inspect_and_dirty_guard(self):
        """A changed HEAD blocks handoffs; dirty status blocks cleanup."""
        state = self.call('inspect', repo=str(self.repo))['result']
        self.assertEqual(state['head'], self.head)
        self.assertTrue(state['clean_including_ignored'])
        self.assertFalse(self.call('guard', repo=str(self.repo), branch='other', head=self.head)['ok'])
        (self.repo / 'source.txt').write_text('dirty\n')
        self.assertEqual(self.call('cleanup-check', repo=str(self.repo), branch='main', head=self.head)['result']['event'], 'preserve')

    def test_ignored_content_prevents_cleanup(self):
        """Ignored files must be reported even when tracked files are clean."""
        with (self.repo / '.git/info/exclude').open('a') as stream:
            stream.write('\nsecret.txt\n')
        (self.repo / 'secret.txt').write_text('preserve me')
        result = self.call('cleanup-check', repo=str(self.repo), branch='main', head=self.head)['result']
        self.assertEqual(result['event'], 'preserve')
        self.assertTrue(any('secret.txt' in entry for entry in result['entries']))

    def test_write_lock_and_delta(self):
        """Atomic publication, lock ownership and snapshot deltas retain evidence."""
        lock = str(self.root / 'lock')
        self.assertTrue(self.call('lock', path=lock, token='one')['ok'])
        self.assertFalse(self.call('lock', path=lock, token='two')['ok'])
        self.assertFalse(self.call('lock', path=lock, token='two', operation='release')['ok'])
        self.assertTrue(self.call('lock', path=lock, token='one', operation='release')['ok'])
        previous, current = self.root / 'before.json', self.root / 'after.json'
        self.call('write', path=str(previous), data={'a': 1, 'b': 2})
        self.call('write', path=str(current), data={'a': 1, 'b': 3, 'c': 4})
        result = self.call('delta', previous=str(previous), current=str(current))['result']
        self.assertEqual(result['changed'], {'b': 3, 'c': 4})
        self.assertEqual(self.call('delta', previous=str(current), current=str(current))['result']['event'], 'unchanged')

    def test_transition_ownership_and_stale_session(self):
        """The state machine refuses wrong roles, stale states and mismatched runs."""
        session = self.root / 'session.json'
        session.write_text(json.dumps({'run_id': 'run', 'worktree': str(self.repo)}))
        fields = dict(repo=str(self.repo), branch='main', head=self.head, session=str(session), run_id='run')
        self.assertTrue(self.call('transition', **fields, role='owner', **{'from': 'missing', 'to': 'coded'})['ok'])
        self.assertFalse(self.call('transition', **fields, role='fix', **{'from': 'coded', 'to': 'coding'})['ok'])
        self.assertTrue(self.call('transition', **fields, role='review', **{'from': 'coded', 'to': 'reviewing'})['ok'])
        self.assertFalse(self.call('transition', **fields, role='review', **{'from': 'coded', 'to': 'reviewing'})['ok'])
        fields['run_id'] = 'wrong'
        self.assertFalse(self.call('transition', **fields, role='review', **{'from': 'reviewing', 'to': 'good'})['ok'])
        self.assertEqual((self.repo / '.status').read_text().strip(), 'reviewing')

    def test_bounded_wait(self):
        """Missing, pending, invalid and terminal states have distinct outcomes."""
        status = self.root / 'status'
        self.assertFalse(self.call('wait', path=str(status), seconds=0)['ok'])
        self.assertEqual(self.call('wait', path=str(status), seconds=0, allow_missing=True)['result']['event'], 'waiting')
        status.write_text('coding\n')
        self.assertEqual(self.call('wait', path=str(status), wanted=['reviewed'], seconds=0)['result']['event'], 'waiting')
        status.write_text('blocked\n')
        self.assertEqual(self.call('wait', path=str(status), wanted=['reviewed'], seconds=0)['result']['event'], 'blocked')
        status.write_text('invalid\n')
        self.assertFalse(self.call('wait', path=str(status), seconds=0)['ok'])

    def test_worktree_branch_collision(self):
        """Creation uses the chosen commit and does not overwrite an occupied branch."""
        worktree = self.root / 'worktree with spaces'
        result = self.call('worktree-create', repo=str(self.repo), branch='fix/123', path=str(worktree), base=self.head)
        self.assertTrue(result['ok'])
        self.assertEqual((worktree / 'source.txt').read_text(), 'initial\n')
        self.assertFalse(self.call('worktree-create', repo=str(self.repo), branch='fix/123', path=str(self.root / 'other'), base=self.head)['ok'])
        self.assertFalse((self.root / 'other').exists())
        self.git('worktree', 'remove', str(worktree))

    @unittest.skipUnless(shutil.which('ssh-keygen'), 'SSH signing tool unavailable')
    def test_signed_commit_verified(self):
        """A locally trusted SSH-signed commit passes the real Git verifier."""
        key = self.root / 'signing-key'
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)], check=True, capture_output=True)
        allowed = self.root / 'allowed-signers'
        allowed.write_text('developer@example.test ' + Path(str(key) + '.pub').read_text())
        self.git('config', 'gpg.format', 'ssh')
        self.git('config', 'user.signingkey', str(key))
        self.git('config', 'gpg.ssh.allowedSignersFile', str(allowed))
        self.git('config', 'commit.gpgsign', 'true')
        (self.repo / 'source.txt').write_text('signed change\n')
        self.git('add', '.')
        self.git('commit', '-m', 'fix: signed fixture')
        head = self.git('rev-parse', 'HEAD').strip()
        result = self.call('verify-commits', repo=str(self.repo), base=self.head, head=head)
        self.assertTrue(result['ok'])
        self.assertEqual(result['result']['commits'], [head])
        self.git('config', 'user.email', 'another@example.test')
        self.assertFalse(self.call('verify-commits', repo=str(self.repo), base=self.head, head=head)['ok'])
        self.assertTrue(self.call('verify-commits', repo=str(self.repo), base=self.head, head=head,
                                  email='developer@example.test')['ok'])


    def test_unsigned_commit_rejected(self):
        """An unsigned new commit cannot pass signature validation."""
        (self.repo / 'source.txt').write_text('new\n')
        self.git('add', '.')
        self.git('commit', '-m', 'fix: fixture')
        head = self.git('rev-parse', 'HEAD').strip()
        self.assertFalse(self.call('verify-commits', repo=str(self.repo), base=self.head, head=head)['ok'])
        self.assertTrue(self.call('verify-commits', repo=str(self.repo), base=head, head=head)['ok'])


if __name__ == '__main__':
    unittest.main()
