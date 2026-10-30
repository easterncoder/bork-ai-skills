'use strict';

const {
  P,
  Fixture,
  suite,
  run,
  which
} = require('../../../../tests/support.js');
/* Explicit opt-in acceptance tests for private installed visual hosts. */
var FIXTURES = P(__filename).withName("fixtures");
class LiveHostTests extends Fixture {
  /* Exercise actual adapters without touching a shared session or launching agents. */
  test_screen_display_geometry_lifecycle_and_restore() {
    /* Verify 1/2/3 trees, discovered display routing and saved-layout cleanup. */
    this.run_fixture("live_screen.js");
  }
  test_app_tree_binding_restart_and_cleanup() {
    /* Verify 1/2/3 trees, owned hc binding, restart reconciliation and cleanup. */
    this.run_fixture("live_app.js");
  }
  run_fixture(name) {
    /* Retain fixture output with exact evidence paths and enforce bounded execution. */
    var result = run([process.execPath, String(P(FIXTURES).join(name))], {
      "capture_output": true,
      "text": true,
      "timeout": 600
    });
    console.log(result.stdout);
    this.assertEqual(result.status, 0, result.stdout + result.stderr);
  }
}
if (require.main === module) suite(LiveHostTests, {
  "test_screen_display_geometry_lifecycle_and_restore": (!((process.env.BORK_TEST_LIVE_HOSTS ?? null) === "1") ? "set BORK_TEST_LIVE_HOSTS=1 for private visual-host fixtures" : false) || (!(which("screen") && which("cc") && P("/proc").isDir()) ? "Linux Screen or C compiler unavailable" : false),
  "test_app_tree_binding_restart_and_cleanup": (!((process.env.BORK_TEST_LIVE_HOSTS ?? null) === "1") ? "set BORK_TEST_LIVE_HOSTS=1 for private visual-host fixtures" : false) || (!["hc", "herdr-app", "Xvfb"].map(tool => which(tool)).every(Boolean) ? "App sandbox dependencies unavailable" : false)
});
module.exports = {
  LiveHostTests
};
