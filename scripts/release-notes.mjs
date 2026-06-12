#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { packageRoot, readPackageJson } from '../lib/package-meta.mjs';
import { normalizeVersion, releaseSection, validateReleaseSection } from '../lib/release-notes.mjs';

const repoRoot = packageRoot(import.meta.url);

function usage() {
  console.log(`release-notes

Usage:
  node scripts/release-notes.mjs [--version VERSION] [--check]

Reads CHANGELOG.md and prints the section for VERSION. If VERSION is omitted,
the current package.json version is used.

Keep one top-level CHANGELOG.md file. For each release, add a new section:

  ## 0.1.3

The printed section is the source for GitHub Release notes and detailed npm
package release descriptions.
`);
}

function parseArgs(argv) {
  const opts = { check: false, help: false, version: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--check') {
      opts.check = true;
    } else if (arg === '--version') {
      opts.version = argv[++i];
      if (opts.version === undefined) throw new Error('Missing value for --version');
    } else if (arg.startsWith('--version=')) {
      opts.version = arg.slice('--version='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  const pkg = readPackageJson(repoRoot);
  const version = normalizeVersion(opts.version || pkg.version);
  const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const section = releaseSection(changelog, version);
  const problems = validateReleaseSection(section, version);

  if (opts.check) {
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exitCode = 1;
      return;
    }
    console.log(`release notes ok: ${version}`);
    return;
  }

  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(section);
}

main();
