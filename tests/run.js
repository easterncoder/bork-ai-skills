'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
if (Number(process.versions.node.split('.')[0]) < 22) {
    console.error('Tests require Node.js 22 or newer; select a supported Node binary.');
    process.exit(1);
}
const root = path.resolve(__dirname, '..');
const directories = ['bork-doitall', 'bork-review'].map(skill => path.join(root, 'skills', skill, 'scripts', 'tests'));
const suites = directories.flatMap(directory => fs.readdirSync(directory).filter(name => /^test_.*\.js$/.test(name)).map(name => path.join(directory, name)));
const requested = process.argv.slice(2);
const selected = requested.length ? requested.map(name => {
    const file = suites.find(file => path.basename(file, '.js') === name.replace(/\.js$/, ''));
    if (!file) throw new Error(`Unknown suite: ${name}`);
    return file;
}) : suites;
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...selected], {stdio: 'inherit', cwd: process.cwd(), timeout: 30 * 60 * 1000});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
