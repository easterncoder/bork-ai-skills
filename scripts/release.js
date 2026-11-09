'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifests = ['plugin.json', '.claude-plugin/plugin.json'];

/** Reject malformed SemVer strings, including leading-zero numeric identifiers. */
function validateVersion(version) {
    const match = typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(version);
    if (!match || [match[4], match[5]].filter(value => value !== undefined).some(value => value.split('.').some(part => !part)) ||
        (match[4] && match[4].split('.').some(part => /^0\d+$/.test(part)))) {
        throw new Error(`Invalid SemVer version: ${version}`);
    }
}

/** Read the source version and require the compatibility manifest to agree. */
function checkVersions() {
    const documents = manifests.map(file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')));
    validateVersion(documents[0].version);
    if (documents[1].version !== documents[0].version) {
        throw new Error(`${manifests[1]} version must match plugin.json (${documents[0].version}).`);
    }
    return documents;
}

/** Run Git against the checkout containing this script, preserving failure details. */
function git(args) {
    const result = spawnSync('git', args, {cwd: root, encoding: 'utf8'});
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed.`);
    return result.stdout.trim();
}

/** Update both manifests and create a signed release commit and matching signed tag. */
function release(version) {
    validateVersion(version);
    const documents = checkVersions();
    if (git(['status', '--porcelain'])) throw new Error('Release requires a clean working tree and index.');
    if (git(['tag', '--list', version])) throw new Error(`Tag ${version} already exists; existing tags are never moved.`);
    if (version === documents[0].version) throw new Error('Choose a new release version.');
    for (const [index, file] of manifests.entries()) {
        documents[index].version = version;
        fs.writeFileSync(path.join(root, file), JSON.stringify(documents[index], null, 2) + '\n');
    }
    git(['add', '--', ...manifests]);
    git(['commit', '-S', '-m', `chore(release): ${version}`]);
    git(['tag', '-s', version, '-m', `Release ${version}`]);
    console.log(`Created signed release ${version}. Nothing was pushed.`);
}

try {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw new Error('Usage: node scripts/release.js --check | VERSION');
    if (args[0] === '--check') console.log(`Manifest versions agree: ${checkVersions()[0].version}`);
    else release(args[0]);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
