'use strict';
const {P, temporary, run, background, sleep, which} = require('../support.js');
/* Start one privately rendered PTY with an owned compiler output and tty record. */
function privatePty(argv, {env, rows = 64, columns = 200} = {}) {
    const temp = temporary({prefix: 'bork-pty-'});
    const root = P(temp.name), binary = root.join('pty'), record = root.join('tty');
    run(['cc', P(__filename).withName('pty.c'), '-lutil', '-o', binary], {check: true});
    const child = background([binary, record, String(rows), String(columns), ...argv], {env});
    /* Wait for this PTY's slave identity without consulting user terminals. */
    function tty() { for (let count = 0; count < 100; count++) { if (record.exists()) return record.readText(); sleep(.02); } throw new Error('Private PTY did not publish its tty'); }
    /* Remove only the stopped broker's files. */
    function cleanup() { child.wait({timeout: 5}); child.dispose(); temp.cleanup(); }
    return {child, tty, cleanup};
}
module.exports = {privatePty};
