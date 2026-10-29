"""Exercise evidence collection, review reuse and automation with offline API fixtures."""

import json
import os
from pathlib import Path
import unittest
import test_workflow as workflow


class EvidenceTests(unittest.TestCase):
    """Verify public helper behavior without GitHub access or AI workers."""

    setUp = workflow.WorkflowTests.setUp
    tearDown = workflow.WorkflowTests.tearDown
    git = workflow.WorkflowTests.git
    call = workflow.WorkflowTests.call

    def save(self, name, data):
        """Write a fixture as a durable JSON artifact."""
        path = self.root / name
        path.write_text(json.dumps(data))
        return str(path)

    def api(self, pages, graphql=False):
        """Install a fake gh that records arguments and returns configured raw pages."""
        binary = self.root / 'bin'
        binary.mkdir(exist_ok=True)
        gh = binary / 'gh'
        gh.write_text('''#!/usr/bin/env python3
import os, pathlib, sys, time
pathlib.Path(os.environ['FAKE_ARGS']).write_text('\u005cn'.join(sys.argv))
time.sleep(float(os.environ.get('FAKE_SLEEP', '0')))
sys.stdout.write(pathlib.Path(os.environ['FAKE_RESPONSE']).read_text())
sys.exit(int(os.environ.get('FAKE_EXIT', '0')))
''')
        gh.chmod(0o755)
        self.env['PATH'] = str(binary) + os.pathsep + os.environ['PATH']
        self.env['FAKE_ARGS'] = str(self.root / 'args')
        self.env['FAKE_RESPONSE'] = self.save('response.json', pages)
        spec = dict(host='github.com', repository='owner/repo', endpoint='repos/owner/repo/issues/1/comments?per_page=100')
        if graphql:
            spec.update(endpoint='graphql', query='query($owner: String!, $name: String!, $endCursor: String) { repository(owner: $owner, name: $name) { items(first: 100, after: $endCursor) { nodes { id body } pageInfo { hasNextPage endCursor } } } }', items_path=['data', 'repository', 'items', 'nodes'], connection_path=['data', 'repository', 'items'])
        return self.save('spec.json', spec)

    def snap(self, spec, name='snapshot.json', **fields):
        """Fetch into a fresh snapshot path."""
        return self.call('snapshot', spec=spec, path=str(self.root / name), **fields)

    def page(self, nodes, more=False):
        """Build one GraphQL connection response."""
        return {'data': {'repository': {'items': {'nodes': nodes, 'pageInfo': {'hasNextPage': more, 'endCursor': 'cursor' if more else None}}}}}

    def test_paginated_snapshot_and_compact_delta(self):
        """All pages are retained while unchanged bodies stay out of model output."""
        spec = self.api([[{'id': 2, 'body': 'full body'}, {'id': 1, 'body': 'first'}], [{'id': 3, 'body': 'third'}]])
        first = self.snap(spec)['result']
        self.assertEqual(first['changed_ids'], ['1', '2', '3'])
        self.assertNotIn('full body', json.dumps(first))
        snapshot = json.loads(Path(first['path']).read_text())
        self.assertEqual(snapshot['entries']['2']['body'], 'full body')
        self.assertTrue(Path(first['path'] + '.raw.json').exists())
        self.api([[{'body': 'third', 'id': 3}, {'body': 'full body', 'id': 2}, {'body': 'first', 'id': 1}]])
        second = self.snap(spec, 'second.json', previous=first['path'])['result']
        self.assertEqual(second['event'], 'unchanged')
        self.api([[{'id': 2, 'body': 'edited'}, {'id': 3, 'body': 'third'}]])
        result = self.snap(spec, 'third.json', previous=second['path'])['result']
        self.assertEqual(result['changed_ids'], ['2'])
        self.assertEqual(result['removed_ids'], ['1'])
        args = (self.root / 'args').read_text()
        self.assertIn('--paginate', args)
        self.assertIn('--slurp', args)
        self.assertIn('GET', args)

    def test_partial_graphql_does_not_publish(self):
        """Errors, truncated pagination and nested omissions never replace complete data."""
        spec = self.api([self.page([{'id': 'a'}], True), self.page([{'id': 'b'}])], graphql=True)
        first = self.snap(spec)['result']
        self.assertEqual(first['count'], 2)
        for i, pages in enumerate([
            [self.page([{'id': 'a'}], True)],
            [{'errors': [{'message': 'unavailable'}], 'data': {}}],
            [self.page([{'id': 'a', 'comments': {'nodes': [], 'pageInfo': {'hasNextPage': True}}}])],
        ]):
            Path(self.env['FAKE_RESPONSE']).write_text(json.dumps(pages))
            result = self.snap(spec, f'bad-{i}.json', previous=first['path'])
            self.assertFalse(result['ok'])
            self.assertFalse((self.root / f'bad-{i}.json').exists())
        self.assertTrue(Path(first['path']).exists())

    def test_snapshot_failure_identity_and_timeout(self):
        """API errors, source changes and timeouts cannot masquerade as empty changes."""
        spec = self.api([[{'id': 1, 'body': 'one'}]])
        first = self.snap(spec)['result']
        self.env['FAKE_EXIT'] = '1'
        self.assertFalse(self.snap(spec, 'error.json', previous=first['path'])['ok'])
        self.env['FAKE_EXIT'] = '0'
        changed = json.loads(Path(spec).read_text())
        changed['endpoint'] = 'repos/owner/repo/issues/2/comments'
        Path(spec).write_text(json.dumps(changed))
        self.assertFalse(self.snap(spec, 'identity.json', previous=first['path'])['ok'])
        self.env['FAKE_SLEEP'] = '2'
        self.assertFalse(self.snap(spec, 'timeout.json', seconds=1)['ok'])
        self.assertFalse((self.root / 'timeout.json').exists())

    def test_mutation_and_conflicting_pagination_rejected(self):
        """Read-only collection refuses mutations and inconsistent duplicated IDs."""
        spec = self.api([[{'id': 1, 'body': 'old'}], [{'id': 1, 'body': 'new'}]])
        self.assertFalse(self.snap(spec)['ok'])
        config = json.loads(Path(spec).read_text())
        config.update(endpoint='graphql', query='mutation($owner: String!, $name: String!) { deleteThing }')
        Path(spec).write_text(json.dumps(config))
        self.assertFalse(self.snap(spec)['ok'])

    def test_brief_identity_and_idempotent_records(self):
        """Briefs preserve identity and uncertain retries cannot overwrite old results."""
        session = self.save('session.json', dict(run_id='run', worktree=str(self.repo), branch='main', head=self.head, base_sha=self.head, pr_url='https://github.com/owner/repo/pull/1', base_repository='owner/repo', head_repository='owner/repo'))
        path = str(self.root / 'brief.json')
        self.assertTrue(self.call('brief', session=session, path=path, data={'role': 'fix', 'cycle': 2})['ok'])
        self.assertEqual(json.loads(Path(path).read_text())['cycle'], 2)
        self.assertFalse(self.call('brief', session=session, path=path, data={'role': 'fix', 'run_id': 'wrong'})['ok'])
        log = str(self.root / 'follow-up.json')
        self.assertEqual(self.call('record', path=log, id='reply:1', data={'url': 'one'})['result']['event'], 'recorded')
        self.assertEqual(self.call('record', path=log, id='reply:1', data={'url': 'one'})['result']['event'], 'unchanged')
        self.assertFalse(self.call('record', path=log, id='reply:1', data={'url': 'two'})['ok'])
        self.assertEqual(json.loads(Path(log).read_text())['reply:1']['url'], 'one')

    def test_review_reuse_and_invalidation(self):
        """Matching evidence allows candidates, but changes and divergence broaden review."""
        review = self.save('review.json', {'coverage': 'full'})
        identity = dict(pr_url='https://github.com/owner/repo/pull/1', base_repository='owner/repo', head_repository='owner/repo', base_sha=self.head, instruction_hash='instructions', intent_hash='intent')
        old = self.save('baseline.json', dict(identity, reviewed_head=self.head, complete=True, review_path=review))
        current = dict(identity, branch='main', head=self.head, context_complete=True)
        path = self.save('current.json', current)
        def check():
            """Check the current fixture through the public helper."""
            return self.call('reuse-review', repo=str(self.repo), previous=old, current=path)['result']['event']
        self.assertEqual(check(), 'reuse_candidate')
        (self.repo / 'source.txt').write_text('changed')
        self.assertEqual(check(), 'full_review')
        self.git('add', '.')
        self.git('commit', '-m', 'fix: changed')
        current['head'] = self.git('rev-parse', 'HEAD').strip()
        self.save('current.json', current)
        self.assertEqual(check(), 'delta_candidate')
        for key in ['base_sha', 'instruction_hash', 'intent_hash', 'pr_url']:
            self.save('current.json', dict(current, **{key: 'changed'}))
            self.assertEqual(check(), 'full_review')
        self.save('current.json', current)
        Path(review).unlink()
        self.assertEqual(check(), 'full_review')

    def polling(self, mode='follow_up', signals=None):
        """Create one immutable polling scope with fresh API evidence."""
        spec = self.api([[{'id': 'pr', 'head': self.head, 'draft': False}]])
        scope = dict(mode=mode, head=self.head, sources={'pr': spec}, signals=signals if signals is not None else {'ci': {'kind': 'check'}, 'bot': {'kind': 'review'}})
        if mode == 'promotion':
            import time
            scope.update(event_id='ready-event', promotion_time=int(time.time()))
        self.scope = self.save('scope.json', scope)
        self.state = str(self.root / 'poll-state.json')
        return self.poll()

    def poll(self):
        """Poll a fixture source through the actual bounded snapshot collector."""
        return self.call('automation-poll', scope=self.scope, state=self.state, directory=str(self.root))

    def assess(self, signals, **extra):
        """Supply evidence classifications tied to the exact complete poll."""
        state = json.loads(Path(self.state).read_text())
        assessment = dict(evidence_hash=state['evidence_hash'], head=self.head, draft=False, activity_hash='scoped-activity', signals=signals)
        assessment.update(extra)
        path = self.save('assessment.json', assessment)
        return self.call('automation-assess', scope=self.scope, state=self.state, assessment=path)

    def signal(self, status='terminal', **extra):
        """Build an explicit SHA-correlated signal."""
        return dict(head=self.head, status=status, evidence=['fixture://result'], **extra)

    def test_missing_pending_failure_and_completion(self):
        """Missing checks stay pending and failed checks return review feedback."""
        self.assertEqual(self.polling()['result']['event'], 'changed')
        self.assertEqual(self.assess({})['result']['event'], 'waiting')
        result = self.assess({'ci': self.signal(), 'bot': self.signal('pending', started=True)})
        self.assertEqual(result['result']['event'], 'waiting')
        self.assertFalse(self.assess({'ci': self.signal(), 'bot': self.signal()})['ok'])
        result = self.assess({'ci': self.signal(failed=True), 'bot': self.signal(started=True, completed_review=True)})
        self.assertEqual(result['result']['event'], 'complete')
        self.assertEqual(result['result']['failed_checks'], ['ci'])
        self.assertEqual(self.poll()['result']['event'], 'complete')

    def test_poll_changes_invalidate_assessment(self):
        """New source evidence requires reassessment; draft and SHA changes remain visible."""
        self.polling()
        signals = {'ci': self.signal(), 'bot': self.signal(completed_review=True)}
        self.assertEqual(self.assess(signals)['result']['event'], 'complete')
        Path(self.env['FAKE_RESPONSE']).write_text(json.dumps([[{'id': 'pr', 'head': self.head, 'draft': True}]]))
        self.assertEqual(self.poll()['result']['event'], 'changed')
        self.assertEqual(self.assess(signals, draft=True)['result']['event'], 'skipped_draft')
        self.assertFalse(self.assess(signals, head='unexpected')['ok'])
        self.assertFalse(self.assess(signals, evidence_hash='stale')['ok'])

    def test_quiet_period_and_infrastructure_failure(self):
        """Quiet completion requires elapsed quiet time and never accepts review failures."""
        self.polling(signals={'ci': {'kind': 'check'}})
        self.assertEqual(self.assess({'ci': self.signal()})['result']['event'], 'waiting')
        state = json.loads(Path(self.state).read_text())
        state['quiet_since'] -= 121
        Path(self.state).write_text(json.dumps(state))
        self.assertEqual(self.poll()['result']['event'], 'complete')
        Path(self.state).unlink()
        self.polling()
        self.assertFalse(self.assess({'ci': self.signal(), 'bot': self.signal(completed_review=True, failed=True)})['ok'])

    def test_promotion_correlation_start_deadline_and_pending(self):
        """Promotion rejects old events and expires only work that never started."""
        import time
        self.polling(mode='promotion', signals={'bot': {'kind': 'review'}})
        self.assertFalse(self.assess({'bot': self.signal(completed_review=True, event_id='old-event')})['ok'])
        self.assertEqual(self.assess({'bot': self.signal('pending', started=True, started_at=int(time.time()) - 602, event_id='ready-event')})['result']['event'], 'waiting')
        scope = json.loads(Path(self.scope).read_text())
        scope['promotion_time'] = int(time.time()) - 601
        Path(self.scope).write_text(json.dumps(scope))
        self.assertFalse(self.poll()['ok'])
        Path(self.state).unlink()
        self.poll()
        self.assertFalse(self.assess({})['ok'])
        self.assertFalse(self.assess({'bot': self.signal('pending', started=True, started_at=int(time.time()), event_id='ready-event')})['ok'])
        self.assertEqual(self.assess({'bot': self.signal('pending', started=True, started_at=int(time.time()) - 602, event_id='ready-event')})['result']['event'], 'waiting')
        self.assertEqual(self.assess({'bot': self.signal(started=True, completed_review=True, started_at=int(time.time()) - 602, event_id='ready-event')})['result']['event'], 'complete')


if __name__ == '__main__':
    unittest.main()
