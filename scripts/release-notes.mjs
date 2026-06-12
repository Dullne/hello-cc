#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');

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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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

function releaseSection(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  const heading = `## ${version}`;
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

function validateSection(section, version) {
  const problems = [];
  if (!section) {
    problems.push(`CHANGELOG.md is missing section ## ${version}`);
    return problems;
  }
  if (!section.includes('### Summary')) problems.push(`## ${version} is missing ### Summary`);
  if (!section.includes('### Highlights')) problems.push(`## ${version} is missing ### Highlights`);
  if (section.includes('TODO') || section.includes('TBD')) problems.push(`## ${version} still contains TODO/TBD text`);
  const bulletCount = (section.match(/^- /gm) || []).length;
  if (bulletCount < 2) problems.push(`## ${version} should include at least two release-note bullets`);
  return problems;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  const pkg = readJson(path.join(repoRoot, 'package.json'));
  const version = opts.version || pkg.version;
  const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const section = releaseSection(changelog, version);
  const problems = validateSection(section, version);

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
