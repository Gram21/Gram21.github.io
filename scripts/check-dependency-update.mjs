#!/usr/bin/env node
/**
 * Refuse a package.json / package-lock.json pair that changes more than versions.
 * Run by update-dependencies.yml on files produced by a job that ran package code,
 * so both are parsed as JSON (the way npm reads them) and checked field by field.
 *
 * Usage: node scripts/check-dependency-update.mjs   (compares with HEAD)
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const REGISTRY = 'https://registry.npmjs.org/';
// A plain semver range: no git, URL, file, tag or alias specs.
const RANGE = /^[~^<>=\s\d.x*|-]+(?:-[\w.]+)?$/;
const GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

const fail = (message) => {
  console.error(`::error::${message}`);
  process.exit(1);
};

const before = JSON.parse(execSync('git show HEAD:package.json', { encoding: 'utf8' }));
const after = JSON.parse(readFileSync('package.json', 'utf8'));

for (const group of GROUPS) {
  const names = (pkg) => Object.keys(pkg[group] ?? {}).join();
  if (names(before) !== names(after)) fail(`package.json: ${group} lists different packages`);
  for (const [name, range] of Object.entries(after[group] ?? {})) {
    if (typeof range !== 'string' || !RANGE.test(range)) {
      fail(`package.json: ${name} has a non-semver spec ${JSON.stringify(range)}`);
    }
  }
  before[group] = after[group] = null;
}
if (JSON.stringify(before) !== JSON.stringify(after)) fail('package.json changed beyond versions');

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (path === '') continue;
  if (entry.link || entry.inBundle) {
    fail(`package-lock.json: ${path} is linked or bundled`);
  }
  if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(REGISTRY)) {
    fail(`package-lock.json: ${path} is not resolved from the npm registry`);
  }
  // The tarball must belong to the package the lockfile names: the last
  // node_modules segment is the name, the URL path is `<name>/-/<file>.tgz`.
  const name = entry.name ?? path.split('node_modules/').at(-1);
  if (!entry.resolved.slice(REGISTRY.length).startsWith(`${name}/-/`)) {
    fail(`package-lock.json: ${path} resolves to a different package than ${name}`);
  }
  if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) {
    fail(`package-lock.json: ${path} has no sha512 integrity hash`);
  }
}
for (const key of Object.keys(lock)) {
  if (!['name', 'version', 'lockfileVersion', 'requires', 'packages'].includes(key)) {
    fail(`package-lock.json: unexpected top-level field ${key}`);
  }
}
console.log('Dependency update changes versions only.');
