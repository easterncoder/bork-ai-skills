"""Migration-sensitive filesystem, process and advisory-lock behavior checks."""

import json
import hashlib
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

NODE = shutil.which(os.environ.get('NODE_BINARY', 'node'))
SUPPORT = Path(__file__).resolve().parents[1] / 'support.js'
RUNNER = SUPPORT.parents[2] / 'bork-doitall/scripts/tmux.js'


class NodeRuntimeTests(unittest.TestCase):
    """Use independent local files and processes without contacting any service."""

    def run_node(self, code, *args):
        """Run a Node fixture from an unrelated working directory."""
        return subprocess.run([NODE, '-e', code, str(SUPPORT), *map(str, args)],
                              cwd=tempfile.gettempdir(), text=True, capture_output=True, timeout=10)

    def test_screen_topology_preserves_newline_splits_and_flat_leaf_ids(self):
        """Replay real Screen dumps with source-compatible replacement semantics."""
        result = self.run_node('''const c=require(process.argv[1]);
const s=require(require('node:path').resolve(require('node:path').dirname(process.argv[1]), '../../bork-doitall/scripts/layout-adapters/screen.js'));
process.stdout.write(c.json_encode(s.borkLayoutScreenTopology('split\\nfocus\\nsplit -v\\nfocus\\nfocus')));
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        topology = json.loads(result.stdout)
        self.assertEqual(topology['leaves'], [0, 1, 3])
        self.assertEqual(topology['nodes'][4]['children'], [1, 3])

    def test_atomic_failure_retains_destination_and_cleans_temporary(self):
        """Rename and serialization failures must leave the prior record intact."""
        with tempfile.TemporaryDirectory(prefix='node atomic ') as directory:
            root = Path(directory)
            target = root / 'record.json'
            target.write_text('{"old":true}')
            link = root / 'link.json'
            link.symlink_to(target)
            blocked = root / 'directory'
            blocked.mkdir()
            result = self.run_node('''const c=require(process.argv[1]);
for(const target of process.argv.slice(2)){try{c.atomicWrite(target,'changed');process.exitCode=1;}catch{}}
const cyclic={};cyclic.self=cyclic;
try{c.atomicWrite(process.argv[2],c.json_encode(cyclic));process.exitCode=1;}catch{}
''', link, blocked)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(target.read_text(), '{"old":true}')
            self.assertEqual(sorted(p.name for p in root.iterdir()), ['directory', 'link.json', 'record.json'])

    def test_runner_retains_spawn_failure_and_signal(self):
        """A failed spawn and signal exit cannot become successful process evidence."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            broken = root / 'broken'
            broken.write_text('#!/missing-owned-test-interpreter\n')
            broken.chmod(0o700)
            for index, argv in enumerate(([str(broken)], [NODE, '-e', 'process.kill(process.pid,"SIGTERM")'])):
                record = root / f'exit-{index}.json'
                job = root / f'job-{index}.json'
                job.write_text(json.dumps({'argv': argv, 'exit_record': str(record)}))
                launch = root / f'launch-{index}.json'
                launch.write_text(json.dumps({'job': str(job), 'cwd': str(root)}))
                result = subprocess.run([NODE, str(RUNNER), 'run', str(launch)], text=True,
                                        capture_output=True, timeout=10)
                evidence = json.loads(record.read_text())
                self.assertNotEqual(result.returncode, 0)
                self.assertNotEqual(evidence['exit_code'], 0)
                self.assertIn('spawn_error' if index == 0 else 'signal', evidence)

    @unittest.skipUnless(shutil.which('flock'), 'util-linux flock is required')
    def test_kernel_lock_contention_and_crash_release(self):
        """A killed lock owner releases its inode without deleting or replacing it."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock = root / 'record.lock'
            ready = root / 'ready'
            holder = subprocess.Popen(['flock', '--exclusive', str(lock), NODE, '-e',
                                       'require("node:fs").writeFileSync(process.argv[1],"ready");setTimeout(()=>{},30000)', str(ready)],
                                      start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                for _ in range(100):
                    if ready.exists():
                        break
                    time.sleep(.02)
                self.assertTrue(ready.exists())
                attempt = subprocess.run(['flock', '--nonblock', str(lock), NODE, '-e', ''], timeout=5)
                self.assertNotEqual(attempt.returncode, 0)
                os.killpg(holder.pid, signal.SIGKILL)
                holder.wait(timeout=5)
                for _ in range(100):
                    attempt = subprocess.run(['flock', '--nonblock', str(lock), NODE, '-e', ''], timeout=5)
                    if attempt.returncode == 0:
                        break
                    time.sleep(.02)
                self.assertEqual(attempt.returncode, 0)
                self.assertTrue(lock.exists())
            finally:
                if holder.poll() is None:
                    os.killpg(holder.pid, signal.SIGKILL)
                    holder.wait(timeout=5)
                holder.stderr.close()

    def test_standalone_and_plugin_modules_ignore_callers_module_type(self):
        """Installed sibling scripts load from arbitrary directories in ES module projects."""
        with tempfile.TemporaryDirectory(prefix='node installed ') as directory:
            root = Path(directory)
            (root / 'package.json').write_text('{"type":"module"}')
            skills = SUPPORT.parents[2]
            for name in ('bork-review', 'bork-doitall'):
                shutil.copytree(skills / name / 'scripts', root / 'skills' / name / 'scripts',
                                ignore=shutil.ignore_patterns('tests', '__pycache__', '*.php'))
            for install in (root / 'skills', root / 'plugin' / 'skills'):
                if install != root / 'skills':
                    shutil.copytree(root / 'skills', install)
                output = root / ('output-' + install.parent.name + '.json')
                payload = {'action': 'write', 'path': str(output), 'data': {'installed': True}}
                result = subprocess.run([NODE, str(install / 'bork-review/scripts/workflow.js')],
                                        input=json.dumps(payload), cwd=tempfile.gettempdir(),
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                self.assertEqual(json.loads(output.read_text()), {'installed': True})

    def test_integer_fields_reject_fractional_tokens_and_unsafe_values(self):
        """Decimal/exponent tokens cannot pass strict integer schema validation."""
        result = self.run_node('''const c=require(process.argv[1]);
const numbers=c.json_decode('[1,1.0,1e0,1.5]');
if(!c.is_int(numbers[0])||numbers.slice(1).some(c.is_int))process.exit(1);
try{c.json_decode('9007199254740993');process.exit(1);}catch{}
process.stdout.write(c.json_encode(numbers));''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [1, 1, 1, 1.5])

    def test_non_ascii_evidence_hash_preserves_existing_serialization(self):
        """Unicode and URLs keep the existing deterministic evidence fingerprint."""
        data = {'url': 'https://example.test/path', 'body': 'café 😀'}
        expected = hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=True,
                                             separators=(',', ':')).encode()).hexdigest()
        result = self.run_node('const e=require(require("node:path").join(require("node:path").dirname(process.argv[1]),"evidence.js"));process.stdout.write(e.evidenceHash(JSON.parse(process.argv[2])));', json.dumps(data))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, expected)

    def test_named_keys_and_empty_lists_keep_their_record_shapes(self):
        """Numeric IDs, false-like values and prototype names remain ordinary data."""
        result = self.run_node('''const c=require(process.argv[1]);
const data=c.json_decode('{"entries":{"12":{"body":"value"}},"empty":[],"__proto__":{"owned":true}}');
if(c.get({},'toString')!==undefined||c.truth('0')||c.truth([]))process.exit(1);
process.stdout.write(c.json_encode(data));''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'entries': {'12': {'body': 'value'}}, 'empty': [], '__proto__': {'owned': True}})


if __name__ == '__main__':
    unittest.main()
