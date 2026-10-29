"""Offline failure injection for the durable batch transition journal."""

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parents[1] / 'batch.php'
PR = 'https://github.com/example/project/pull/12'
HEAD = 'a' * 40


class BatchTests(unittest.TestCase):
    """Run the public PHP helper with disposable local records only."""

    def setUp(self):
        """Create an empty batch directory with no GitHub or Git dependency."""
        self.temp = tempfile.TemporaryDirectory(prefix='batch-state-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plan = self.root / 'plan.json'
        self.counter = 0
        self.revision = 0

    def call(self, action, **fields):
        """Call one transition and track its saved revision after success."""
        self.counter += 1
        source = self.root / f'input-{self.counter}.json'
        payload = {'action': action, 'plan_path': str(self.plan), **fields}
        if action not in ('init', 'inspect') and 'expected_revision' not in payload:
            payload['expected_revision'] = self.revision
        source.write_text(json.dumps(payload))
        process = subprocess.run(['php', str(HELPER), str(source)], capture_output=True, text=True, timeout=10)
        output = json.loads(process.stdout)
        self.assertEqual(process.returncode, 0 if output['ok'] else 1, process.stderr)
        if output['ok'] and 'state_revision' in output['result']:
            self.revision = output['result']['state_revision']
        return output

    def write(self, name, content):
        """Publish a fake durable worker or remote evidence record."""
        path = self.root / name
        path.write_text(json.dumps(content))
        return str(path)

    def approved_plan(self, merge=False, no_reviewer=False):
        """Build the exact approved preview and normalized single-target queue."""
        preview = 'issue 12, serial, native, merge=' + str(merge) + ', NOREVIEWER=' + str(no_reviewer)
        return {
            'schema_version': 5,
            'batch_id': 'offline-12',
            'approved_preview': preview,
            'approval_evidence': {'response': 'go', 'preview_sha256': hashlib.sha256(preview.encode()).hexdigest()},
            'max_concurrency': 1,
            'merge_enabled': merge,
            'skip_ready_goodcode': no_reviewer,
            'reviewer': 'NONE' if no_reviewer else 'custom-reviewer',
            'targets': {'12': {'status': 'queued', 'depends_on': []}},
        }

    def start(self, merge=False, no_reviewer=False):
        """Approve, reserve, and attach the one simulated master."""
        self.assertTrue(self.call('init', plan=self.approved_plan(merge, no_reviewer))['ok'])
        self.assertEqual(self.call('reserve')['result']['launch'], ['12'])
        self.assertTrue(self.call('started', target_id='12', agent_id='master-1')['ok'])

    def child(self, phase, head=HEAD):
        """Simulate a child that wrote its result before its parent crashed."""
        path = str(self.root / f'{phase}.json')
        fields = {'target_id': '12', 'phase': phase, 'result_path': path}
        if phase != 'prify':
            fields['pr_url'] = PR
        self.assertTrue(self.call('phase-start', **fields)['ok'])
        result = {'phase': phase, 'status': 'complete', 'pr_url': PR, 'published_head': head, 'cleanup_success': True}
        if phase != 'prify':
            result.update(reviewed_head=head, workers_stopped=True)
        self.write(f'{phase}.json', result)
        return path

    def adopt(self, phase, head=HEAD):
        """Reconcile the already published child result against remote facts."""
        return self.call('phase-adopt', target_id='12', phase=phase, agent_stopped=True,
                         descendants_stopped=True, remote={'pr_url': PR, 'head': head})

    def blocked_resume(self):
        """Retain a pending original child and construct explicit recovery evidence."""
        self.start(no_reviewer=True)
        path = self.child('prify')
        self.write('prify.json', {'phase': 'prify', 'status': 'blocked', 'pr_url': PR, 'published_head': HEAD})
        self.assertTrue(self.call('target-blocked', target_id='12', master_stopped=True,
                                  descendants_stopped=True, reason='original blocker', evidence_path=path)['ok'])
        plan = json.loads(self.plan.read_text())
        remote = {'pr_url': PR, 'head': HEAD, 'state': 'OPEN', 'is_draft': True}
        evidence = {'batch_id': plan['batch_id'], 'target_id': '12',
                    'approved_preview_sha256': hashlib.sha256(plan['approved_preview'].encode()).hexdigest(),
                    'prior_master_agent_id': 'master-1', 'recovered_master_agent_id': 'master-2',
                    'user_instruction': 'continue the same approved work', 'user_continuation': True,
                    'scope_unchanged': True, 'prior_master_stopped': True, 'children_reconciled': True,
                    'remote': remote}
        return plan, evidence, remote

    def test_target_resume_preserves_pending_phase_and_blocker(self):
        """Resume the same original result without replaying phase or publication intent."""
        before, evidence, remote = self.blocked_resume()
        path = self.write('resume.json', evidence)
        self.assertTrue(self.call('target-resume', target_id='12', agent_id='master-2', evidence_path=path, remote=remote)['ok'])
        after = json.loads(self.plan.read_text())
        self.assertEqual(after['state_revision'], before['state_revision'] + 1)
        target = after['targets']['12']
        self.assertEqual(target['status'], 'running')
        self.assertEqual(target['master_agent_id'], 'master-2')
        self.assertEqual(target['blocker'], before['targets']['12']['blocker'])
        self.assertEqual(target['phase_records'], before['targets']['12']['phase_records'])
        self.assertEqual(target['resume_history'][0]['blocker'], target['blocker'])
        for key in before:
            if key not in ('targets', 'state_revision'):
                self.assertEqual(after[key], before[key])
        self.write('prify.json', {'phase': 'prify', 'status': 'complete', 'pr_url': PR,
                                 'published_head': HEAD, 'cleanup_success': True})
        self.assertTrue(self.adopt('prify')['ok'])

    def test_target_resume_preserves_history_and_rejects_linked_evidence(self):
        """Keep completed intents and older recovery history while rejecting linked records."""
        before, evidence, remote = self.blocked_resume()
        target = before['targets']['12']
        target['mutations'] = {'review_request': {'status': 'complete', 'head': HEAD}}
        target['resume_history'] = [{'blocker': {'reason': 'older blocker'}, 'evidence_path': 'older.json'}]
        self.plan.write_text(json.dumps(before))
        path = self.write('resume.json', evidence)
        linked = self.root / 'linked-resume.json'
        linked.symlink_to(path)
        self.assertFalse(self.call('target-resume', target_id='12', agent_id='master-2',
                                   evidence_path=str(linked), remote=remote)['ok'])
        self.assertEqual(json.loads(self.plan.read_text()), before)
        self.assertTrue(self.call('target-resume', target_id='12', agent_id='master-2',
                                  evidence_path=path, remote=remote)['ok'])
        after = json.loads(self.plan.read_text())['targets']['12']
        self.assertEqual(after['mutations'], target['mutations'])
        self.assertEqual(after['resume_history'][:-1], target['resume_history'])
        self.assertEqual(after['resume_history'][-1]['evidence_sha256'],
                         hashlib.sha256(Path(path).read_bytes()).hexdigest())

    def test_target_resume_rejects_unverified_continuation(self):
        """Reject stale, active-owner, changed-scope and mismatched-remote recovery."""
        before, evidence, remote = self.blocked_resume()
        for field, value in [('user_continuation', False), ('prior_master_stopped', False),
                             ('scope_unchanged', False), ('children_reconciled', False),
                             ('prior_master_agent_id', 'unrelated'), ('approved_preview_sha256', 'wrong')]:
            with self.subTest(field=field):
                path = self.write('resume.json', {**evidence, field: value})
                self.assertFalse(self.call('target-resume', target_id='12', agent_id='master-2', evidence_path=path, remote=remote)['ok'])
                self.assertEqual(json.loads(self.plan.read_text()), before)
        path = self.write('resume.json', evidence)
        self.assertFalse(self.call('target-resume', target_id='12', agent_id='master-2', evidence_path=path, remote=remote, expected_revision=0)['ok'])
        self.assertFalse(self.call('target-resume', target_id='12', agent_id='master-2', evidence_path=str(self.root/'missing.json'), remote=remote)['ok'])
        self.assertFalse(self.call('target-resume', target_id='12', agent_id='master-2', evidence_path=path, remote={**remote, 'head': 'b'*40})['ok'])

    def test_target_resume_rejects_pending_mutation_and_capacity(self):
        """Never revive blocked targets over uncertain external actions or occupied slots."""
        before, evidence, remote = self.blocked_resume()
        path = self.write('resume.json', evidence)
        for change in ('mutation', 'capacity', 'dependency', 'nonblocked'):
            plan = json.loads(json.dumps(before))
            if change == 'mutation':
                plan['targets']['12']['mutations'] = {'ready': {'status': 'pending'}}
            elif change == 'capacity':
                plan['targets']['13'] = {'status': 'running', 'depends_on': []}
            elif change == 'dependency':
                plan['targets']['13'] = {'status': 'blocked', 'depends_on': []}
                plan['targets']['12']['depends_on'] = ['13']
            else:
                plan['targets']['12']['status'] = 'running'
            self.plan.write_text(json.dumps(plan))
            self.assertFalse(self.call('target-resume', target_id='12', agent_id='master-2', evidence_path=path, remote=remote)['ok'])
            self.assertEqual(json.loads(self.plan.read_text()), plan)

    def test_environment_selection_persistence_and_resume(self):
        """Retain the approved driver across a changed coordinator environment."""
        plan = self.approved_plan()
        plan['execution_driver'] = 'herdr'
        plan['environment_selection'] = {
            'version': 1, 'execution_driver': 'herdr',
            'contexts': {'herdr': {'active': True, 'pane_id': 'w1:p1', 'socket': '/tmp/herdr', 'shell_pid': 123}, 'tmux': {'active': False}},
            'capability': {'supported': True, 'evidence': 'Verified terminal and native child capacity'},
        }
        self.assertTrue(self.call('init', plan=plan)['ok'])
        self.assertTrue(self.call('reserve')['ok'])
        self.assertEqual(json.loads(self.plan.read_text())['environment_selection'], plan['environment_selection'])
        self.assertTrue(self.call('inspect', target_id='12')['ok'])
        self.assertEqual(json.loads(self.plan.read_text())['execution_driver'], 'herdr')

    def test_screen_selection_persistence_and_resume(self):
        """Retain exact Screen resources through durable batch resume."""
        plan = self.approved_plan()
        plan['execution_driver'] = 'screen'
        plan['environment_selection'] = {
            'version': 1, 'execution_driver': 'screen',
            'contexts': {'herdr': {'active': False}, 'tmux': {'active': False},
                         'screen': {'active': True, 'pane_id': '0', 'socket': '123.fixture',
                                    'session_id': '123.fixture', 'socket_dir': '/tmp/fixture', 'shell_pid': 124}},
            'capability': {'supported': True, 'evidence': 'Verified Screen capacity'},
        }
        self.assertTrue(self.call('init', plan=plan)['ok'])
        self.assertTrue(self.call('reserve')['ok'])
        self.assertTrue(self.call('inspect', target_id='12')['ok'])
        saved = json.loads(self.plan.read_text())
        self.assertEqual(saved['execution_driver'], 'screen')
        self.assertEqual(saved['environment_selection'], plan['environment_selection'])

    def test_environment_selection_mismatch_is_rejected(self):
        """Refuse a driver inconsistent with its approved membership evidence."""
        plan = self.approved_plan()
        plan['execution_driver'] = 'tmux'
        plan['environment_selection'] = {
            'version': 1, 'execution_driver': 'native',
            'contexts': {'herdr': {'active': False}, 'tmux': {'active': False}},
            'capability': {'supported': True, 'evidence': 'native capacity'},
        }
        self.assertFalse(self.call('init', plan=plan)['ok'])
        self.assertFalse(self.plan.exists())

    def test_legacy_driver_is_not_reselected(self):
        """An older approved native plan needs no new environment evidence."""
        plan = self.approved_plan()
        plan['execution_driver'] = 'native'
        self.assertTrue(self.call('init', plan=plan)['ok'])
        self.assertTrue(self.call('reserve')['ok'])
        self.assertEqual(json.loads(self.plan.read_text())['execution_driver'], 'native')

    def test_go_gate_and_atomic_reservation(self):
        """Reject an unapproved plan and stale concurrent queue changes."""
        plan = self.approved_plan()
        plan['approval_evidence']['response'] = 'no-go'
        self.assertFalse(self.call('init', plan=plan)['ok'])
        self.assertFalse(self.plan.exists())
        self.assertTrue(self.call('init', plan=self.approved_plan())['ok'])
        self.assertEqual(self.call('reserve')['result']['launch'], ['12'])
        self.assertFalse(self.call('reserve', expected_revision=0)['ok'])
        self.assertEqual(self.call('reserve')['result']['launch'], [])
        self.assertEqual(json.loads(self.plan.read_text())['targets']['12']['status'], 'starting')

    def test_push_and_pr_creation_crash_adopts_one_prify_result(self):
        """A lost master cannot launch a second prify after publication."""
        self.start()
        self.child('prify')
        self.assertEqual(self.call('inspect', target_id='12')['result']['event'], 'reconcile_phase')
        self.assertFalse(self.call('phase-start', target_id='12', phase='prify', result_path=str(self.root / 'again.json'))['ok'])
        self.assertFalse(self.call('target-complete', target_id='12', result_path=str(self.root / 'none.json'), master_stopped=True, descendants_stopped=True)['ok'])
        self.assertFalse(self.call('phase-adopt', target_id='12', phase='prify', agent_stopped=True,
                                   descendants_stopped=True, remote={'pr_url': PR, 'head': 'b' * 40})['ok'])
        self.assertTrue(self.adopt('prify')['ok'])
        self.assertFalse(self.adopt('prify')['ok'])
        self.assertEqual(json.loads(self.plan.read_text())['targets']['12']['pr_url'], PR)

    def test_promotion_bot_gate_and_master_loss(self):
        """Each completed phase survives a master restart without replay."""
        self.start()
        self.child('prify')
        self.assertTrue(self.adopt('prify')['ok'])
        self.child('draft_goodcode')
        self.assertTrue(self.adopt('draft_goodcode')['ok'])
        self.assertEqual(self.call('mutation-start', target_id='12', kind='ready', pr_url=PR, expected_head=HEAD)['result']['event'], 'perform_once')
        self.assertEqual(self.call('inspect', target_id='12')['result']['event'], 'reconcile_mutation')
        self.assertFalse(self.call('mutation-start', target_id='12', kind='ready', pr_url=PR, expected_head=HEAD)['ok'])
        self.assertFalse(self.call('mutation-observe', target_id='12', kind='ready', remote={'pr_url': PR, 'head': HEAD, 'is_draft': True})['ok'])
        self.assertTrue(self.call('mutation-observe', target_id='12', kind='ready', remote={'pr_url': PR, 'head': HEAD, 'is_draft': False})['ok'])
        self.assertFalse(self.call('phase-start', target_id='12', phase='ready_goodcode', pr_url=PR, result_path=str(self.root / 'too-soon.json'))['ok'])
        evidence = self.write('reviewer-gate.json', {'status': 'complete', 'pr_url': PR, 'head': HEAD, 'reviewer': 'custom-reviewer'})
        self.assertTrue(self.call('gate-complete', target_id='12', evidence_path=evidence, remote={'pr_url': PR, 'head': HEAD})['ok'])
        self.assertFalse(self.call('gate-complete', target_id='12', evidence_path=evidence, remote={'pr_url': PR, 'head': HEAD})['ok'])
        self.child('ready_goodcode')
        self.assertTrue(self.adopt('ready_goodcode')['ok'])
        report = self.write('target-result.json', {'status': 'complete', 'pr_url': PR, 'published_head': HEAD, 'cleanup_success': True})
        self.assertFalse(self.call('target-complete', target_id='12', result_path=report, master_stopped=False,
                                   descendants_stopped=True, remote={'pr_url': PR, 'head': HEAD})['ok'])
        self.assertTrue(self.call('target-complete', target_id='12', result_path=report, master_stopped=True,
                                  descendants_stopped=True, remote={'pr_url': PR, 'head': HEAD})['ok'])
        self.assertEqual(json.loads(self.plan.read_text())['targets']['12']['status'], 'complete')

    def test_legacy_reviewer_gate_resumes_without_repeating(self):
        """Old gate records permit continuation while rejecting a second request gate."""
        self.start()
        self.child('prify')
        self.assertTrue(self.adopt('prify')['ok'])
        evidence = self.write('reviewer-gate.json', {'status': 'complete', 'pr_url': PR,
                                                   'head': HEAD, 'reviewer': 'custom-reviewer'})
        self.assertTrue(self.call('gate-complete', target_id='12', evidence_path=evidence,
                                  remote={'pr_url': PR, 'head': HEAD})['ok'])
        plan = json.loads(self.plan.read_text())
        records = plan['targets']['12']['phase_records']
        self.assertIn('reviewer_gate', records)
        self.assertNotIn('cspf', records)
        records['cspf'] = records.pop('reviewer_gate')
        self.plan.write_text(json.dumps(plan))
        self.assertFalse(self.call('gate-complete', target_id='12', evidence_path=evidence,
                                   remote={'pr_url': PR, 'head': HEAD})['ok'])
        self.child('ready_goodcode')
        self.assertTrue(self.adopt('ready_goodcode')['ok'])

    def test_uncertain_merge_is_never_repeated(self):
        """A lost merge response stays pending until remote evidence is checked."""
        self.start(merge=True)
        self.child('prify')
        self.assertTrue(self.adopt('prify')['ok'])
        self.child('draft_goodcode')
        self.assertTrue(self.adopt('draft_goodcode')['ok'])
        self.assertTrue(self.call('mutation-start', target_id='12', kind='ready', pr_url=PR, expected_head=HEAD)['ok'])
        self.assertTrue(self.call('mutation-observe', target_id='12', kind='ready', remote={'pr_url': PR, 'head': HEAD, 'is_draft': False})['ok'])
        evidence = self.write('reviewer-gate.json', {'status': 'complete', 'pr_url': PR, 'head': HEAD, 'reviewer': 'custom-reviewer'})
        self.assertTrue(self.call('gate-complete', target_id='12', evidence_path=evidence, remote={'pr_url': PR, 'head': HEAD})['ok'])
        self.child('ready_goodcode')
        self.assertTrue(self.adopt('ready_goodcode')['ok'])
        report = self.write('target-result.json', {'status': 'complete', 'pr_url': PR, 'published_head': HEAD, 'cleanup_success': True})
        self.assertTrue(self.call('target-complete', target_id='12', result_path=report, master_stopped=True,
                                  descendants_stopped=True, remote={'pr_url': PR, 'head': HEAD})['ok'])
        self.assertTrue(self.call('mutation-start', target_id='12', kind='merge', pr_url=PR, expected_head=HEAD)['ok'])
        self.assertEqual(self.call('inspect', target_id='12')['result']['event'], 'reconcile_mutation')
        self.assertFalse(self.call('mutation-start', target_id='12', kind='merge', pr_url=PR, expected_head=HEAD)['ok'])
        self.assertTrue(self.call('merge-running', target_id='12')['ok'])
        self.assertFalse(self.call('merge-running', target_id='12')['ok'])
        self.assertFalse(self.call('mutation-observe', target_id='12', kind='merge', remote={'pr_url': PR, 'head': HEAD, 'merged': False})['ok'])
        observed = {'pr_url': PR, 'head': HEAD, 'merged': True, 'merge_commit_url': 'https://github.com/example/project/commit/' + HEAD}
        self.assertTrue(self.call('mutation-observe', target_id='12', kind='merge', remote=observed)['ok'])
        self.assertEqual(json.loads(self.plan.read_text())['targets']['12']['merge_status'], 'merged')

    def test_blocked_target_releases_slot_only_after_agents_stop(self):
        """Failure evidence cannot free a running slot while a child survives."""
        self.start()
        evidence = self.write('blocked.json', {'status': 'blocked', 'reason': 'push outcome unknown'})
        self.assertFalse(self.call('target-blocked', target_id='12', reason='push outcome unknown',
                                   evidence_path=evidence, master_stopped=True, descendants_stopped=False)['ok'])
        self.assertEqual(self.call('reserve')['result']['launch'], [])
        self.assertTrue(self.call('target-blocked', target_id='12', reason='push outcome unknown',
                                  evidence_path=evidence, master_stopped=True, descendants_stopped=True)['ok'])
        self.assertEqual(json.loads(self.plan.read_text())['targets']['12']['status'], 'blocked')

    def test_uncertain_merge_can_be_blocked_only_after_unmerged_observation(self):
        """A failed merge attempt retains its intent and requires remote reconciliation."""
        self.start(merge=True)
        self.child('prify')
        self.assertTrue(self.adopt('prify')['ok'])
        self.child('draft_goodcode')
        self.assertTrue(self.adopt('draft_goodcode')['ok'])
        self.assertTrue(self.call('mutation-start', target_id='12', kind='ready', pr_url=PR, expected_head=HEAD)['ok'])
        self.assertTrue(self.call('mutation-observe', target_id='12', kind='ready', remote={'pr_url': PR, 'head': HEAD, 'is_draft': False})['ok'])
        evidence = self.write('reviewer-gate.json', {'status': 'complete', 'pr_url': PR, 'head': HEAD, 'reviewer': 'custom-reviewer'})
        self.assertTrue(self.call('gate-complete', target_id='12', evidence_path=evidence, remote={'pr_url': PR, 'head': HEAD})['ok'])
        self.child('ready_goodcode')
        self.assertTrue(self.adopt('ready_goodcode')['ok'])
        report = self.write('target-result.json', {'status': 'complete', 'pr_url': PR, 'published_head': HEAD, 'cleanup_success': True})
        self.assertTrue(self.call('target-complete', target_id='12', result_path=report, master_stopped=True,
                                  descendants_stopped=True, remote={'pr_url': PR, 'head': HEAD})['ok'])
        self.assertTrue(self.call('mutation-start', target_id='12', kind='merge', pr_url=PR, expected_head=HEAD)['ok'])
        self.assertFalse(self.call('merge-blocked', target_id='12', reason='mergeability unknown')['ok'])
        self.assertTrue(self.call('merge-blocked', target_id='12', reason='mergeability unknown',
                                  remote={'pr_url': PR, 'head': HEAD, 'merged': False})['ok'])
        self.assertFalse(self.call('mutation-start', target_id='12', kind='merge', pr_url=PR, expected_head=HEAD)['ok'])

    def test_noreviewer_skips_external_gate_and_ready_run(self):
        """The approved skip requires draft work and promotion without external review."""
        self.start(no_reviewer=True)
        self.child('prify')
        self.assertTrue(self.adopt('prify')['ok'])
        self.child('draft_goodcode')
        self.assertTrue(self.adopt('draft_goodcode')['ok'])
        self.assertTrue(self.call('mutation-start', target_id='12', kind='ready', pr_url=PR, expected_head=HEAD)['ok'])
        self.assertTrue(self.call('mutation-observe', target_id='12', kind='ready', remote={'pr_url': PR, 'head': HEAD, 'is_draft': False})['ok'])
        self.assertFalse(self.call('phase-start', target_id='12', phase='ready_goodcode', result_path=str(self.root / 'ready.json'))['ok'])
        report = self.write('target-result.json', {'status': 'complete', 'pr_url': PR, 'published_head': HEAD,
                                                   'cleanup_success': True, 'ready_goodcode_status': 'skipped_noreviewer'})
        remote = {'pr_url': PR, 'head': HEAD, 'is_draft': False}
        self.assertTrue(self.call('target-complete', target_id='12', result_path=report, master_stopped=True,
                                  descendants_stopped=True, remote=remote)['ok'])
        self.assertEqual(json.loads(self.plan.read_text())['targets']['12']['merge_status'], 'skipped_not_requested')

    def test_noreviewer_and_domerge_use_applicable_completed_phases(self):
        """The approved merge intent can proceed after the skipped ready phase."""
        self.start(merge=True, no_reviewer=True)
        self.child('prify')
        self.assertTrue(self.adopt('prify')['ok'])
        self.child('draft_goodcode')
        self.assertTrue(self.adopt('draft_goodcode')['ok'])
        self.assertTrue(self.call('mutation-start', target_id='12', kind='ready', pr_url=PR, expected_head=HEAD)['ok'])
        remote = {'pr_url': PR, 'head': HEAD, 'is_draft': False}
        self.assertTrue(self.call('mutation-observe', target_id='12', kind='ready', remote=remote)['ok'])
        report = self.write('target-result.json', {'status': 'complete', 'pr_url': PR, 'published_head': HEAD,
                                                   'cleanup_success': True, 'ready_goodcode_status': 'skipped_noreviewer'})
        self.assertTrue(self.call('target-complete', target_id='12', result_path=report, master_stopped=True,
                                  descendants_stopped=True, remote=remote)['ok'])
        self.assertEqual(self.call('mutation-start', target_id='12', kind='merge', pr_url=PR,
                                   expected_head=HEAD)['result']['event'], 'perform_once')
        self.assertFalse(self.call('mutation-start', target_id='12', kind='merge', pr_url=PR,
                                   expected_head=HEAD)['ok'])


    def test_default_reviewer_and_arbitrary_values(self):
        """New plans default to NONE and preserve arbitrary reviewer names."""
        plan = self.approved_plan()
        del plan['reviewer']
        del plan['skip_ready_goodcode']
        self.assertTrue(self.call('init', plan=plan)['ok'])
        saved = json.loads(self.plan.read_text())
        self.assertEqual(saved['reviewer'], 'NONE')
        self.assertTrue(saved['skip_ready_goodcode'])
        self.plan.unlink()
        for reviewer in ['some-user', 'org/team', 'review-bot[bot]', 'none']:
            plan = self.approved_plan()
            plan['reviewer'] = reviewer
            self.assertTrue(self.call('init', plan=plan)['ok'])
            self.assertEqual(json.loads(self.plan.read_text())['reviewer'], reviewer)
            self.plan.unlink()
        plan['reviewer'] = 'NONE'
        self.assertFalse(self.call('init', plan=plan)['ok'])

    def test_review_profile_defaults_and_validates(self):
        """New plans default to the generic profile and reject unknown profiles."""
        self.assertTrue(self.call('init', plan=self.approved_plan())['ok'])
        self.assertEqual(json.loads(self.plan.read_text())['review_profile'], 'generic')
        self.plan.unlink()
        plan = self.approved_plan()
        profile = self.root / 'profile.md'
        profile.write_text('# Supplied rules\n')
        plan['review_profile'] = str(profile)
        self.assertFalse(self.call('init', plan=plan)['ok'])
        plan['review_profile_sha256'] = hashlib.sha256(profile.read_bytes()).hexdigest()
        self.assertTrue(self.call('init', plan=plan)['ok'])
        self.assertEqual(json.loads(self.plan.read_text())['review_profile'], str(profile))
        self.plan.unlink()
        profile.write_text('# Changed rules\n')
        self.assertFalse(self.call('init', plan=plan)['ok'])
        profile.unlink()
        self.assertFalse(self.call('init', plan=plan)['ok'])
        plan['review_profile'] = 'other'
        self.assertFalse(self.call('init', plan=plan)['ok'])

    def test_effort_override_validates(self):
        """An optional effort override accepts only the three tier names."""
        for value in ['low', 'standard', 'high']:
            plan = self.approved_plan()
            plan['effort_override'] = value
            self.assertTrue(self.call('init', plan=plan)['ok'])
            self.assertEqual(json.loads(self.plan.read_text())['effort_override'], value)
            self.plan.unlink()
        plan['effort_override'] = 'max'
        self.assertFalse(self.call('init', plan=plan)['ok'])

    def test_ready_pr_gate_rejects_wrong_reviewer(self):
        """An initially ready PR needs evidence from its selected reviewer."""
        self.start()
        self.child('prify')
        self.assertTrue(self.adopt('prify')['ok'])
        evidence = self.write('review.json', {'status': 'complete', 'pr_url': PR,
                                             'head': HEAD, 'reviewer': 'other-user'})
        self.assertFalse(self.call('gate-complete', target_id='12', evidence_path=evidence,
                                   remote={'pr_url': PR, 'head': HEAD})['ok'])
        self.write('review.json', {'status': 'complete', 'pr_url': PR,
                                  'head': HEAD, 'reviewer': 'custom-reviewer'})
        self.assertTrue(self.call('gate-complete', target_id='12', evidence_path=evidence,
                                  remote={'pr_url': PR, 'head': HEAD})['ok'])

if __name__ == '__main__':
    unittest.main()
