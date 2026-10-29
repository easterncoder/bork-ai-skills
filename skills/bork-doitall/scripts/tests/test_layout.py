"""Shared layout planning and isolated real tmux placement checks."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parents[1] / 'layout.js'
TMUX = HELPER.with_name('tmux.js')


class LayoutTests(unittest.TestCase):
    """Verify topology, journaling and resource protection through public actions."""

    def setUp(self):
        """Create private input files and a unique tmux server address."""
        self.temp = tempfile.TemporaryDirectory(prefix='bork-layout-')
        self.root = Path(self.temp.name)
        self.socket = self.root.name
        self.index = 0

    def tearDown(self):
        """Stop only this fixture's private tmux server."""
        if shutil.which('tmux'):
            subprocess.run(['tmux', '-L', self.socket, 'kill-server'], capture_output=True)
        self.temp.cleanup()

    def invoke(self, action, data, helper=HELPER):
        """Invoke the public helper with an immutable JSON request."""
        self.index += 1
        path = self.root / f'input-{self.index}.json'
        path.write_text(json.dumps(data))
        proc = subprocess.run([shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'), str(helper), action, str(path)], capture_output=True, text=True, timeout=15)
        result = json.loads(proc.stdout)
        self.assertEqual(proc.returncode, 0 if result['ok'] else 1, proc.stderr)
        return result

    def tmux(self, *args):
        """Address the isolated fixture server by its unique socket name."""
        return subprocess.check_output(['tmux', '-L', self.socket, *args], text=True).strip()

    def create(self, count=1):
        """Provision inside an existing coordinator pane beside unrelated work."""
        coordinator = self.tmux('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'fixture', '-x', '260', '-y', '90')
        self.tmux('set-option', '-t', 'fixture', 'default-shell', '/bin/sh')
        self.tmux('set-option', '-t', 'fixture', 'default-command', '')
        unrelated = self.tmux('split-window', '-d', '-P', '-F', '#{pane_id}', '-v', '-l', '10', '-t', coordinator)
        data = {'driver': 'tmux', 'context': {'socket': self.socket}, 'coordinator': coordinator,
                'concurrency': count, 'record': str(self.root / 'layout.json'), 'cwd': str(self.root), 'run_id': 'fixture'}
        result = self.invoke('create', data)
        self.assertTrue(result['ok'], result)
        return data, result['result'], unrelated

    def test_topology_for_all_concurrency_values(self):
        """Coordinator spans all rows and each review sits over its matching fix."""
        for count in (1, 2, 3):
            result = self.invoke('plan', {'concurrency': count, 'area': {'x': 5, 'y': 7, 'width': 200, 'height': 80}})
            self.assertTrue(result['ok'], result)
            slots = result['result']['slots']
            self.assertEqual(len(slots), 1 + count * 3)
            self.assertEqual(slots['coordinator']['height'], 80)
            previous_bottom = 6
            for slot in range(1, count + 1):
                master, review, fix = [slots[f'{role}:{slot}'] for role in ('master', 'review', 'fix')]
                self.assertGreater(master['y'], previous_bottom)
                self.assertEqual(master['y'], review['y'])
                self.assertGreater(review['x'], master['x'])
                self.assertEqual(review['x'], fix['x'])
                self.assertEqual(fix['y'], review['y'] + review['height'] + 1)
                self.assertEqual(master['height'], review['height'] + fix['height'] + 1)
                previous_bottom = master['y'] + master['height'] - 1

    def test_insufficient_geometry_and_bad_limits(self):
        """Unusable sizes and invalid concurrency fail before driver mutation."""
        for count in (0, 4, '2', True):
            self.assertFalse(self.invoke('plan', {'concurrency': count, 'area': {'x': 0, 'y': 0, 'width': 180, 'height': 60}})['ok'])
        for width, height in ((60, 60), (200, 15)):
            self.assertFalse(self.invoke('plan', {'concurrency': 3, 'area': {'x': 0, 'y': 0, 'width': width, 'height': height}})['ok'])

    def test_headless_hc_does_not_call_app(self):
        """Headless capability is explicit and requires no app mutation or process."""
        result = self.invoke('preflight', {'driver': 'hc'})
        self.assertTrue(result['ok'])
        self.assertFalse(result['result']['visual'])
        self.assertTrue(result['result']['supported'])

    def test_herdr_adapter_command_and_identity_contract(self):
        """Use documented response fixtures to verify exact target and returned IDs."""
        stub = self.root / 'herdr'
        calls = self.root / 'calls.jsonl'
        layout = {'zoomed': False, 'tab_id': 'w1:t1', 'workspace_id': 'w1',
                  'focused_pane_id': 'w1:p1', 'panes': [{'pane_id': 'w1:p1',
                  'rect': {'x': 0, 'y': 0, 'width': 200, 'height': 80}}]}
        stub.write_text('#!/usr/bin/env python3\nimport sys,json\n'
                        + f'with open({str(calls)!r}, "a") as f: f.write(json.dumps(sys.argv[1:])+"\\n")\n'
                        + f'layout={layout!r}\n'
                        + 'result={"layout":layout} if sys.argv[1:3]==["pane","layout"] else {"pane":{"pane_id":"w1:p2"}}\n'
                        + 'print(json.dumps({"result":result}))\n')
        stub.chmod(0o700)
        record = {'context': {}, 'coordinator': 'w1:p1', 'cwd': str(self.root),
                  'resources': {'coordinator': {'id': 'w1:p1'}}}
        code = 'const a=require(require("node:path").join(require("node:path").dirname(process.argv[1]),"layout-adapters/herdr.js"));const r=JSON.parse(process.argv[2]);console.log(require(require("node:path").resolve(require("node:path").dirname(process.argv[1]), "../../bork-review/scripts/support.js")).json_encode([a.borkLayoutHerdrSnapshot([],"w1:p1"),a.borkLayoutHerdrSplit(r,{parent:"coordinator",direction:"right",size:150})]));'
        env = {**os.environ, 'PATH': str(self.root) + os.pathsep + os.environ['PATH'], 'HERDR_ENV': '1'}
        result = subprocess.run([shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'), '-e', code, str(HELPER), json.dumps(record)], env=env,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        snapshot, pane = json.loads(result.stdout)
        self.assertEqual(snapshot['focus'], 'w1:p1')
        self.assertEqual(snapshot['panes']['w1:p1']['width'], 200)
        self.assertEqual(pane, 'w1:p2')
        split = json.loads(calls.read_text().splitlines()[-1])
        self.assertEqual(split[:6], ['pane', 'split', '--pane', 'w1:p1', '--direction', 'right'])
        self.assertIn('--no-focus', split)
        self.assertAlmostEqual(float(split[split.index('--ratio') + 1]), 50 / 200)

    @unittest.skipUnless(shutil.which('tmux'), 'tmux unavailable')
    def test_real_geometry_focus_and_cleanup(self):
        """All three real tree sizes preserve unrelated panes and focus on cleanup."""
        for count in (1, 2, 3):
            with self.subTest(concurrency=count):
                data, record, unrelated = self.create(count)
                self.assertEqual(self.tmux('display-message', '-p', '-t', 'fixture', '#{pane_id}'), data['coordinator'])
                self.assertEqual(len(record['resources']), count * 3 + 1)
                cleanup = self.invoke('cleanup', {'record': data['record'], 'results_verified': True, 'descendants_stopped': True})
                self.assertTrue(cleanup['ok'], cleanup)
                self.assertEqual(set(self.tmux('list-panes', '-t', 'fixture', '-F', '#{pane_id}').splitlines()), {data['coordinator'], unrelated})
                self.tmux('kill-server')
                Path(data['record']).unlink()

    @unittest.skipUnless(shutil.which('tmux'), 'tmux unavailable')
    def test_claim_release_turnover_and_duplicate_guard(self):
        """Cycles reuse placement while active or uncertain launches cannot duplicate it."""
        data, record, _ = self.create()
        claim = {'record': data['record'], 'role': 'review', 'slot': 1, 'target_id': 'i1', 'task_id': 'review-1'}
        first = self.invoke('claim', claim)
        self.assertTrue(first['ok'], first)
        self.assertFalse(self.invoke('claim', claim)['ok'])
        self.assertFalse(self.invoke('cleanup', {'record': data['record'], 'results_verified': True, 'descendants_stopped': True})['ok'])
        result_path = self.root / 'result.json'
        result_path.write_text(json.dumps({'status': 'complete'}))
        release = {'record': data['record'], 'placement': 'review:1', 'task_id': 'review-1', 'result_path': str(result_path),
                   'results_verified': True, 'worker_stopped': True, 'descendants_stopped': True}
        self.assertTrue(self.invoke('release', release)['ok'])
        claim['target_id'], claim['task_id'] = 'i2', 'review-2'
        second = self.invoke('claim', claim)
        self.assertEqual(first['result']['id'], second['result']['id'])
        self.assertFalse(self.invoke('create', data)['ok'])

    @unittest.skipUnless(shutil.which('tmux'), 'tmux unavailable')
    def test_release_accepts_good_role_results_and_rejects_pending(self):
        """Real goodcode result statuses release both roles only after shutdown."""
        data, _, _ = self.create()
        result_path = self.root / 'role-result.json'
        for role in ('review', 'fix'):
            task = role + '-1'
            claim = {'record': data['record'], 'role': role, 'slot': 1, 'target_id': 'i1', 'task_id': task}
            self.assertTrue(self.invoke('claim', claim)['ok'])
            release = {'record': data['record'], 'placement': role + ':1', 'task_id': task,
                       'result_path': str(result_path), 'results_verified': True,
                       'worker_stopped': True, 'descendants_stopped': True}
            for status in ('pending', '', 'coding'):
                result_path.write_text(json.dumps({'role': role, 'task_id': task, 'status': status}))
                self.assertFalse(self.invoke('release', release)['ok'])
            result_path.write_text(json.dumps({'role': role, 'task_id': task, 'status': 'good'}))
            self.assertFalse(self.invoke('release', {**release, 'worker_stopped': False})['ok'])
            self.assertTrue(self.invoke('release', release)['ok'])

    def test_app_binding_uses_claimed_child_identity(self):
        """Bind the child run and task while rejecting unrelated terminal identities."""
        hc = self.root / 'hc'
        app = self.root / 'herdr-app'
        terminal_path = self.root / 'terminal.json'
        doc = {'value': {'spaces': [{'id': 's1', 'tabs': [{'id': 'tab1', 'root': {
            'type': 'row', 'id': 'root', 'children': [
                {'type': 'block', 'id': 'coord', 'content': {'terminal': 't1'}},
                {'type': 'block', 'id': 'review', 'content': {'terminal': 't2'}}]}}]}]}, 'version': 1}
        hc.write_text('#!/usr/bin/env python3\nimport sys,json\nr=json.loads(sys.stdin.readline())\n'
                      + f'doc={doc!r}\n'
                      + f'terminal=json.load(open({str(terminal_path)!r}))\n'
                      + 'v={"server.status":{"core":{"id":"core1"}},"doc.get":doc,"terminal.get":terminal}[r["method"]]\n'
                      + 'print(json.dumps({"result":v}))\n')
        app.write_text('#!/usr/bin/env python3\nimport json\nprint(json.dumps({"space":"s1","tab":"tab1","focused_pane":"coord","overlays":[],"errors":[]}))\n')
        hc.chmod(0o700)
        app.chmod(0o700)
        terminal = {'address': 'child-terminal', 'cols': 50, 'rows': 40, 'created_ms': 42,
                    'labels': {'bork-run': 'child', 'bork-task': 'review-1'}}
        record = {'driver': 'hc', 'state': 'ready', 'run_id': 'batch', 'coordinator': 'coord',
                  'context': {'core_id': 'core1', 'root_area': {'x': 0, 'y': 0, 'width': 101, 'height': 40}},
                  'original': {'focus': 'coord', 'panes': {'coord': {'window': 'tab1', 'x': 0, 'y': 0, 'width': 50, 'height': 40}}},
                  'plan': {'slots': {'coordinator': {'x': 0, 'y': 0, 'width': 50, 'height': 40},
                                     'review:1': {'x': 51, 'y': 0, 'width': 50, 'height': 40}}},
                  'resources': {'coordinator': {'id': 'coord'}, 'review:1': {'id': 'review', 'state': 'claimed',
                                'run_id': 'child', 'task_id': 'review-1'}}}
        path = self.root / 'app-layout.json'
        path.write_text(json.dumps(record))
        request = {'record': str(path), 'placement': 'review:1', 'task_id': 'review-1', 'run_id': 'child',
                   'terminal_id': 'child-terminal', 'created_ms': 42}
        env = {**os.environ, 'PATH': str(self.root) + os.pathsep + os.environ['PATH']}
        def bind(data, identity):
            """Call the production binding with a controlled core response."""
            terminal_path.write_text(json.dumps(identity))
            self.index += 1
            request_path = self.root / f'bind-{self.index}.json'
            request_path.write_text(json.dumps(data))
            proc = subprocess.run([shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'), str(HELPER), 'bind', str(request_path)], env=env,
                                  capture_output=True, text=True, timeout=15)
            return json.loads(proc.stdout)
        for change in ({'address': 'other'}, {'created_ms': 43},
                       {'labels': {'bork-run': 'other', 'bork-task': 'review-1'}},
                       {'labels': {'bork-run': 'child', 'bork-task': 'other'}}):
            self.assertFalse(bind(request, {**terminal, **change})['ok'])
        self.assertFalse(bind({**request, 'run_id': 'other'}, terminal)['ok'])
        self.assertFalse(bind({**request, 'task_id': 'other'}, terminal)['ok'])
        self.assertTrue(bind(request, terminal)['ok'])

    @unittest.skipUnless(shutil.which('tmux'), 'tmux unavailable')
    def test_resize_and_uncertain_split_block_claim(self):
        """Geometry drift and pending journal intents pause new worker assignment."""
        data, record, _ = self.create()
        request = {'record': data['record'], 'role': 'master', 'slot': 1, 'target_id': 'i1', 'task_id': 'master-1'}
        self.tmux('resize-pane', '-t', record['resources']['review:1']['id'], '-L', '3')
        self.assertFalse(self.invoke('claim', request)['ok'])
        record['pending'] = {'operation': 'split', 'before': {}}
        Path(data['record']).write_text(json.dumps(record))
        self.assertFalse(self.invoke('claim', request)['ok'])
        self.assertTrue(self.invoke('inspect', {'record': data['record']})['ok'])

    @unittest.skipUnless(shutil.which('tmux'), 'tmux unavailable')
    def test_occupied_placeholder_is_preserved(self):
        """A foreign process in an idle slot blocks reassignment and cleanup."""
        data, record, _ = self.create()
        pane = record['resources']['review:1']['id']
        self.tmux('respawn-pane', '-k', '-t', pane, 'sleep 60')
        request = {'record': data['record'], 'role': 'review', 'slot': 1, 'target_id': 'i1', 'task_id': 'review-1'}
        self.assertFalse(self.invoke('claim', request)['ok'])
        self.assertFalse(self.invoke('cleanup', {'record': data['record'], 'results_verified': True, 'descendants_stopped': True})['ok'])
        self.assertIn(pane, self.tmux('list-panes', '-t', 'fixture', '-F', '#{pane_id}').splitlines())

    @unittest.skipUnless(shutil.which('tmux'), 'tmux unavailable')
    def test_launcher_uses_recorded_role_pane(self):
        """An integrated launch stays in its assigned pane and existing window."""
        data, record, _ = self.create()
        job = self.root / 'job.json'
        job.write_text(json.dumps({'argv': [shutil.which(os.environ.get('NODE_BINARY', 'node')) or os.environ.get('NODE_BINARY', 'node'), '-e', 'console.log("layout worker");'], 'exit_record': str(self.root / 'exit.json')}))
        launch = {'role': 'master', 'cwd': str(self.root), 'job': str(job), 'session_name': 'unused-legacy-name',
                  'socket': self.socket, 'layout_record': data['record'], 'slot': 1, 'task_id': 'master-1', 'target_id': 'i1'}
        result = self.invoke('launch', launch, TMUX)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['result']['pane'], record['resources']['master:1']['id'])
        self.assertEqual(self.tmux('list-sessions', '-F', '#{session_name}'), 'fixture')
        self.assertEqual(self.tmux('show-options', '-Awv', '-t', 'fixture', 'pane-border-status'), 'off')
        self.assertTrue(self.invoke('claim', {'record': data['record'], 'role': 'review', 'slot': 1, 'target_id': 'i1', 'task_id': 'review-1'})['ok'])


if __name__ == '__main__':
    unittest.main()
