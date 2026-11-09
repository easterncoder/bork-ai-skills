'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {test} = require('node:test');
const source = path.resolve(__dirname, '..');
const manifests = ['plugin.json', '.claude-plugin/plugin.json'];

/** Create an isolated checkout with disposable signing identity and owned cleanup. */
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bork-release-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const env = {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'};
    /** Run fixture commands without inheriting personal Git settings. */
    function run(command, args) {
        const result = spawnSync(command, args, {cwd: root, env, encoding: 'utf8', timeout: 10000});
        if (result.error) throw result.error;
        return result;
    }
    /** Execute checked Git operations inside the disposable checkout. */
    function git(...args) {
        const result = run('git', args);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        return result.stdout.trim();
    }
    for (const file of ['scripts/release.js', ...manifests]) {
        fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
        fs.copyFileSync(path.join(source, file), path.join(root, file));
    }
    git('init', '-q');
    git('config', 'user.name', 'Release Fixture');
    git('config', 'user.email', 'release@example.test');
    git('config', 'commit.gpgsign', 'false');
    git('add', '.');
    git('commit', '-qm', 'chore: initialize fixture');
    /** Invoke the copied release command from outside its checkout. */
    function release(version) {
        return spawnSync(process.execPath, [path.join(root, 'scripts/release.js'), version], {cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 10000});
    }
    return {root, run, git, release};
}

/** Require manifest agreement and valid source versions through the public CLI. */
test('release check detects drift and malformed source versions', t => {
    const f = fixture(t);
    assert.equal(f.release('--check').status, 0);
    const compatibility = path.join(f.root, manifests[1]);
    const original = fs.readFileSync(compatibility, 'utf8');
    const document = JSON.parse(original);
    document.version = '0.0.1';
    fs.writeFileSync(compatibility, JSON.stringify(document));
    const mismatch = f.release('--check');
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /must match plugin.json/);
    fs.writeFileSync(compatibility, original);
    const primary = path.join(f.root, manifests[0]);
    const invalid = JSON.parse(fs.readFileSync(primary, 'utf8'));
    invalid.version = '01.0.0';
    fs.writeFileSync(primary, JSON.stringify(invalid));
    assert.match(f.release('--check').stderr, /Invalid SemVer/);
});

/** Invalid SemVer inputs must leave the checkout untouched. */
test('release rejects invalid versions before writing files', t => {
    const f = fixture(t);
    for (const version of ['v1.0.0', '1.2', '01.2.3', '1.02.3', '1.2.03', '1.2.3-01', '1.2.3-a..b', '1.2.3+build.', '1.2.3\n']) {
        const result = f.release(version);
        assert.equal(result.status, 1, version);
        assert.match(result.stderr, /Invalid SemVer/, version);
    }
    assert.equal(f.git('status', '--porcelain'), '');
    assert.equal(f.git('tag', '--list'), '');
});

/** A release must tag the signed commit containing both synchronized versions. */
test('release creates verified signed commit and matching signed tag', t => {
    const f = fixture(t);
    const key = path.join(f.root, '.git', 'fixture-key');
    assert.equal(f.run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'release@example.test', '-f', key]).status, 0);
    const allowed = path.join(f.root, '.git', 'allowed-signers');
    fs.writeFileSync(allowed, `release@example.test ${fs.readFileSync(key + '.pub', 'utf8')}`);
    f.git('config', 'gpg.format', 'ssh');
    f.git('config', 'user.signingkey', key);
    f.git('config', 'gpg.ssh.allowedSignersFile', allowed);
    const version = '0.4.0-rc.1+build.2';
    const result = f.release(version);
    assert.equal(result.status, 0, result.stderr);
    for (const file of manifests) assert.equal(JSON.parse(f.git('show', `HEAD:${file}`)).version, version);
    assert.equal(f.git('rev-parse', `${version}^{commit}`), f.git('rev-parse', 'HEAD'));
    assert.equal(f.git('log', '-1', '--format=%s'), `chore(release): ${version}`);
    f.git('verify-commit', 'HEAD');
    f.git('verify-tag', version);
    assert.equal(f.git('status', '--porcelain'), '');
});

/** Dirty files and existing release tags must prevent mutation. */
test('release refuses dirty checkouts and preserves existing tags', t => {
    const f = fixture(t);
    const before = f.git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(f.root, 'unrelated.txt'), 'pending work');
    assert.match(f.release('0.4.0').stderr, /clean working tree/);
    fs.unlinkSync(path.join(f.root, 'unrelated.txt'));
    f.git('tag', '0.4.0');
    assert.match(f.release('0.4.0').stderr, /already exists/);
    assert.equal(f.git('rev-parse', '0.4.0'), before);
    assert.equal(f.git('rev-parse', 'HEAD'), before);
    assert.equal(f.git('status', '--porcelain'), '');
});

/** Failed signing must never produce an unsigned release commit or tag. */
test('release stops before tagging when commit signing fails', t => {
    const f = fixture(t);
    const before = f.git('rev-parse', 'HEAD');
    f.git('config', 'gpg.format', 'ssh');
    f.git('config', 'user.signingkey', path.join(f.root, '.git', 'missing-key'));
    assert.notEqual(f.release('0.4.0').status, 0);
    assert.equal(f.git('rev-parse', 'HEAD'), before);
    assert.equal(f.git('tag', '--list'), '');
});
