"""Verify the terminal runner shared by Herdr and tmux without either server."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


HELPER = Path(__file__).resolve().parents[1] / 'tmux.php'


class TerminalRunnerTests(unittest.TestCase):
    """Exercise process evidence independently of multiplexer availability."""

    def test_shell_commands_preserve_paths_and_do_not_execute_path_content(self):
        """Run generated commands through available destination shells."""
        shells = [
            ('posix', shutil.which('sh'), ['-c']),
            ('powershell', shutil.which('pwsh') or shutil.which('powershell'), ['-NoProfile', '-Command']),
            ('cmd', shutil.which('cmd.exe'), ['/d', '/s', '/c']),
        ]
        php = shutil.which('php')
        for shell, executable, flags in shells:
            if not executable:
                continue
            with self.subTest(shell=shell), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                name = "space ' & $() `touch injected` ! %" if shell != 'cmd' else 'space & (literal)'
                nested = root / name
                nested.mkdir()
                record = nested / 'exit.json'
                job = nested / 'job.json'
                job.write_text(json.dumps({
                    'argv': [php, '-r', 'echo "runner output";'],
                    'exit_record': str(record),
                }))
                launch = nested / 'launch.json'
                launch.write_text(json.dumps({'shell': shell, 'cwd': str(root), 'job': str(job)}))
                built = subprocess.run(
                    [php, str(HELPER), 'command', str(launch)],
                    capture_output=True, text=True, timeout=10, check=True,
                )
                command = json.loads(built.stdout)['result']['command']
                result = subprocess.run(
                    [executable, *flags, command], cwd=root,
                    capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('runner output', result.stdout)
                self.assertEqual(json.loads(record.read_text())['exit_code'], 0)
                self.assertFalse((root / 'injected').exists())

    def test_unsafe_cmd_expansion_is_rejected_before_submission(self):
        """Cmd cannot safely preserve percent expansion in the launch path."""
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / '%PATH%.json'
            source.write_text(json.dumps({'shell': 'cmd'}))
            result = subprocess.run(
                [shutil.which('php'), str(HELPER), 'command', str(source)],
                capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 1)
            self.assertFalse(json.loads(result.stdout)['ok'])

    def test_codex_launch_requires_a_real_global_no_daemon_flag(self):
        """Reject text and option operands before any provider can execute."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / 'codex'
            executable.write_text('#!/bin/sh\ntouch "' + str(root / 'ran') + '"\n')
            executable.chmod(0o700)
            rejected = [[], ['task --no-daemon'], ['-m', '--no-daemon'],
                        ['--config', '--no-daemon'], ['--', '--no-daemon'],
                        ['exec', 'task --no-daemon'], ['--profile=--no-daemon']]
            accepted = [['--no-daemon', 'task'], ['task', '--no-daemon'], ['--no-daemon', 'exec', 'task'],
                        ['-m', 'gpt-6.1-sol', '--no-daemon', 'task']]
            for index, args in enumerate(rejected + accepted):
                with self.subTest(args=args):
                    job = root / f'job-{index}.json'
                    record = root / f'exit-{index}.json'
                    job.write_text(json.dumps({'argv': [str(executable), *args],
                                               'exit_record': str(record)}))
                    launch = root / f'launch-{index}.json'
                    launch.write_text(json.dumps({'cwd': directory, 'job': str(job)}))
                    result = subprocess.run(['php', str(HELPER), 'run', str(launch)],
                                            capture_output=True, text=True, timeout=10)
                    if args in rejected:
                        self.assertEqual(result.returncode, 1, result.stdout)
                        self.assertIn('--no-daemon', json.loads(result.stdout)['error'])
                        self.assertFalse((root / 'ran').exists())
                        self.assertFalse(record.exists())
                        launch.write_text(json.dumps({'cwd': directory, 'job': str(job),
                                                      'shell': 'posix', 'layout_record': str(root / 'absent-layout.json')}))
                        rejected_launch = subprocess.run(['php', str(HELPER.with_name('herdr.php')),
                                                          'launch', str(launch)],
                                                         capture_output=True, text=True, timeout=10)
                        self.assertEqual(rejected_launch.returncode, 1)
                        self.assertIn('--no-daemon', json.loads(rejected_launch.stdout)['error'])
                        self.assertFalse((root / 'absent-layout.json').exists())
                    else:
                        self.assertEqual(result.returncode, 0, result.stdout)
                        self.assertTrue((root / 'ran').exists())
                        (root / 'ran').unlink()

    def test_runner_preserves_exit_and_output_without_tmux(self):
        """Successful and failed commands publish their actual exit code."""
        php = shutil.which('php')
        for code in (0, 7):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                record = root / 'exit.json'
                job = root / 'job.json'
                job.write_text(json.dumps({
                    'argv': [php, '-r', f'echo getcwd(); exit({code});'],
                    'exit_record': str(record),
                }))
                launch = root / 'launch.json'
                launch.write_text(json.dumps({'cwd': str(root), 'job': str(job), 'role': 'master'}))
                env = dict(os.environ, PATH='')
                result = subprocess.run(
                    [php, str(HELPER), 'run', str(launch)],
                    capture_output=True, text=True, env=env, timeout=10,
                )
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertEqual(result.stdout, str(root))
                evidence = json.loads(record.read_text())
                self.assertEqual(evidence['exit_code'], code)
                retry = subprocess.run(
                    [php, str(HELPER), 'run', str(launch)],
                    capture_output=True, text=True, env=env, timeout=10,
                )
                self.assertEqual(retry.returncode, 1)
                self.assertFalse(json.loads(retry.stdout)['ok'])
                self.assertEqual(json.loads(record.read_text()), evidence)


if __name__ == '__main__':
    unittest.main()
