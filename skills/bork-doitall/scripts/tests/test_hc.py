"""Exercise hc discovery and durable lifecycle contracts without a shared core."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parents[1] / 'environment.php'
PHP = r'''
require $argv[1];
$x = json_decode(stream_get_contents(STDIN), true);
$run = static function ($args) use ($x) {
    $key = implode(' ', $args);
    if (!isset($x['commands'][$key])) { throw new RuntimeException('Unexpected command: ' . $key); }
    return $x['commands'][$key];
};
try {
    if ($x['mode'] === 'detect') {
        $contexts = detectEnvironment(static fn ($k) => $x['env'][$k] ?? false, $run,
            static fn ($pid) => in_array($pid, $x['ancestors'], true), $x['expected'] ?? null);
        $selection = selectEnvironment($contexts, $x['capabilities']);
        validateEnvironmentSelection(['execution_driver' => $selection['execution_driver'], 'environment_selection' => $selection]);
        $result = $selection;
    } else {
        $result = hcAction($x['action'], $x['input'], $run);
    }
    echo json_encode(['ok' => true, 'result' => $result]);
} catch (Throwable $e) { echo json_encode(['ok' => false, 'error' => $e->getMessage()]); }
'''


class HcTests(unittest.TestCase):
    """Use installed-schema responses and real durable files with injected commands."""

    def setUp(self):
        """Create independent immutable job and lifecycle paths for every case."""
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.record = self.root / 'record.json'
        self.job = self.root / 'job.json'
        self.job.write_text(json.dumps({'argv': ['/bin/cat'], 'exit_record': str(self.root / 'exit.json')}))
        self.terminal = {'address': 't7', 'created_ms': 1234, 'pid': 123, 'state': 'live',
                         'name': 'bork-test', 'labels': {'bork-run': 'run-1'}, 'status': {'state': 'idle'}}
        self.commands = {'hc server status': json.dumps({'core': {'id': 'core-1'}}),
                         'hc get t7': json.dumps(self.terminal),
                         'hc --skill': '--no-daemon first_message.sent', 'hc --version': 'hc 0.1.13'}
        for command, flag in {'run': '--bg', 'send': '--if', 'wait': '--timeout', 'get': 'TERMINAL',
                              'read': '--lines', 'interrupt': 'TERMINAL', 'kill': 'TERMINAL', 'rm': 'TERMINAL'}.items():
            self.commands[f'hc {command} --help'] = flag
        self.input = {'record': str(self.record), 'job': str(self.job), 'cwd': str(self.root),
                      'name': 'bork-test', 'role': 'review', 'run_id': 'run-1', 'task_id': 'task-1'}

    def call(self, **data):
        """Run production PHP functions and expose failures as structured evidence."""
        result = subprocess.run(['php', '-r', PHP, str(HELPER)],
                                input=json.dumps({'commands': self.commands, **data}), text=True,
                                capture_output=True, check=True, timeout=10)
        return json.loads(result.stdout)

    def saved(self, **changes):
        """Publish a previously owned terminal record for lifecycle recovery cases."""
        record = {**self.input, 'core_id': 'core-1', 'terminal_id': 't7', 'created_ms': 1234,
                  'state': 'awaiting_result', **changes}
        self.record.write_text(json.dumps(record))

    def test_membership_priority_identity_and_capacity(self):
        """Real caller ancestry and selected hc capacity are required before persistence."""
        data = {'mode': 'detect', 'env': {'HC_TERMINAL_ID': 't7'}, 'ancestors': [123],
                'capabilities': {'hc': {'supported': True, 'evidence': 'fixture capacity'}}}
        result = self.call(**data)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['result']['execution_driver'], 'hc')
        for patch in ({'ancestors': []}, {'env': {'HC_TERMINAL_ID': 'elsewhere/t7'}},
                      {'capabilities': {'hc': {'supported': False, 'blocker': 'no host capacity'}}}):
            self.assertFalse(self.call(**{**data, **patch})['ok'])
        self.commands['hc send --help'] = 'incompatible'
        self.assertFalse(self.call(**data)['ok'])

    def test_installation_and_hidden_context(self):
        """An installed binary or session routing variable alone is not membership."""
        data = {'mode': 'detect', 'env': {'HC_SESSION': 'test'}, 'ancestors': [],
                'capabilities': {'native': {'supported': True, 'evidence': 'native fixture'}}}
        self.assertEqual(self.call(**data)['result']['execution_driver'], 'native')
        self.assertFalse(self.call(**data, expected='hc')['ok'])

    def test_launch_delivery_and_duplicate_prevention(self):
        """Compact launches persist returned IDs before requiring receipt acknowledgment."""
        command = f'hc run --json --bg --name bork-test --cwd {self.root} --label bork-run=run-1 /bin/cat'
        self.commands[command] = json.dumps({'address': 't7', 'first_message': {'sent': False}})
        result = self.call(mode='action', action='launch', input=self.input)
        self.assertTrue(result['ok'], result)
        saved = json.loads(self.record.read_text())
        self.assertEqual(saved['state'], 'delivery_requires_reconciliation')
        self.assertEqual(saved['created_ms'], 1234)
        self.assertFalse(self.call(mode='action', action='launch', input=self.input)['ok'])
        ack = self.root / 'ack.json'
        ack.write_text(json.dumps({'run_id': 'run-1', 'terminal_id': 't7', 'task_id': 'wrong'}))
        self.assertFalse(self.call(mode='action', action='acknowledge', input={**self.input, 'acknowledgment': str(ack)})['ok'])

    def test_codex_requires_no_daemon_and_launch_failure_retains_intent(self):
        """Template expansion cannot bypass Codex containment or erase uncertain launches."""
        executable = self.root / 'codex'
        executable.write_text('#!/bin/sh\nexit 0\n')
        executable.chmod(0o700)
        self.job.write_text(json.dumps({'argv': [str(executable), 'task'], 'exit_record': str(self.root / 'exit.json')}))
        self.assertFalse(self.call(mode='action', action='launch', input=self.input)['ok'])
        self.assertFalse(self.record.exists())
        self.job.write_text(json.dumps({'argv': [str(executable), '--no-daemon', '-p', 'profile', 'task'], 'exit_record': str(self.root / 'exit.json')}))
        self.assertFalse(self.call(mode='action', action='launch', input=self.input)['ok'])
        self.assertEqual(json.loads(self.record.read_text())['state'], 'launch_uncertain')

    def test_uncertain_launch_reconciles_without_relaunch(self):
        """Only one run-labeled terminal on the original core can recover an address."""
        self.saved(state='launch_uncertain')
        self.commands['hc ls --all'] = json.dumps({'terminals': [{'address': 't7', 'name': 'bork-test'}]})
        self.assertTrue(self.call(mode='action', action='reconcile', input=self.input)['ok'])
        self.terminal['created_ms'] = 4321
        self.commands['hc get t7'] = json.dumps(self.terminal)
        self.assertFalse(self.call(mode='action', action='reconcile', input=self.input)['ok'])
        self.terminal['labels'] = {'bork-run': 'another-run'}
        self.commands['hc get t7'] = json.dumps(self.terminal)
        self.assertFalse(self.call(mode='action', action='reconcile', input=self.input)['ok'])

    def test_attention_uncertain_send_and_no_status_success(self):
        """Blocked prompts never receive input and statuses cannot report completed work."""
        self.saved(state='send_uncertain')
        self.assertFalse(self.call(mode='action', action='send', input={**self.input, 'task': 'retry'})['ok'])
        self.terminal['status']['state'] = 'blocked'
        self.commands['hc get t7'] = json.dumps(self.terminal)
        self.commands['hc read t7 --lines 120'] = 'Permission required: approve this action?'
        result = self.call(mode='action', action='inspect', input=self.input)
        self.assertEqual(result['result']['observation'], 'attention')
        self.assertIn('Permission required', result['result']['prompt_output'])
        self.assertEqual(result['result']['navigation'], 'hc attach t7')
        self.assertFalse(self.call(mode='action', action='send', input={**self.input, 'task': 'yes'})['ok'])
        self.terminal['status']['state'] = 'done'
        self.commands['hc get t7'] = json.dumps(self.terminal)
        self.assertEqual(self.call(mode='action', action='inspect', input=self.input)['result']['observation'], 'requires_result_and_ack')

    def test_cleanup_requires_result_descendants_and_exact_ownership(self):
        """Only a verified finished owned terminal may be removed after output capture."""
        self.saved()
        self.assertFalse(self.call(mode='action', action='cleanup', input=self.input)['ok'])
        self.terminal['state'] = 'finished'
        self.commands['hc get t7'] = json.dumps(self.terminal)
        self.commands['hc read t7 --lines 120'] = 'retained output'
        self.commands['hc rm t7'] = json.dumps({'removed': 't7'})
        request = {**self.input, 'results_verified': True, 'descendants_stopped': True}
        self.assertEqual(self.call(mode='action', action='cleanup', input=request)['result']['state'], 'removed')
        self.commands['hc server status'] = json.dumps({'core': {'id': 'replacement'}})
        self.assertFalse(self.call(mode='action', action='cleanup', input=request)['ok'])
