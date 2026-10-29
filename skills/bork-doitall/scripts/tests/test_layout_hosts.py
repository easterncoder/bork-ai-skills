"""Explicit opt-in acceptance tests for private installed visual hosts."""

import os
import shutil
import subprocess
import unittest
from pathlib import Path

FIXTURES = Path(__file__).with_name('fixtures')


@unittest.skipUnless(os.environ.get('BORK_TEST_LIVE_HOSTS') == '1', 'set BORK_TEST_LIVE_HOSTS=1 for private visual-host fixtures')
class LiveHostTests(unittest.TestCase):
    """Exercise actual adapters without touching a shared session or launching agents."""

    @unittest.skipUnless(shutil.which('screen') and Path('/proc').is_dir(), 'Linux Screen unavailable')
    def test_screen_display_geometry_lifecycle_and_restore(self):
        """Verify 1/2/3 trees, discovered display routing and saved-layout cleanup."""
        self.run_fixture('live_screen.py')

    @unittest.skipUnless(all(shutil.which(tool) for tool in ['hc', 'herdr-app', 'Xvfb']), 'App sandbox dependencies unavailable')
    def test_app_tree_binding_restart_and_cleanup(self):
        """Verify 1/2/3 trees, owned hc binding, restart reconciliation and cleanup."""
        self.run_fixture('live_app.py')

    def run_fixture(self, name):
        """Retain fixture output with exact evidence paths and enforce bounded execution."""
        result = subprocess.run(['python3', str(FIXTURES / name)], capture_output=True, text=True, timeout=600)
        print(result.stdout, end='')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
