#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { packageRoot, readPackageJson } from '../lib/release/package-meta.mjs';
import {
  normalizeVersion,
  releaseSection,
  repoFromPackage,
  validateReleaseSection
} from '../lib/release/release-notes.mjs';

const repoRoot = packageRoot(import.meta.url);
const githubApi = 'https://api.github.com';

function usage() {
  console.log(`github-release

Usage:
  node scripts/github-release.mjs [--version VERSION] [--repo OWNER/REPO] [--dry-run]

Creates or updates the GitHub Release for vVERSION using the matching
CHANGELOG.md section as the release body.

Authentication:
  Set GH_TOKEN or GITHUB_TOKEN to a token with repo release permissions.
`);
}

function parseArgs(argv) {
  const opts = { dryRun: false, help: false, repo: null, version: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--repo') {
      opts.repo = argv[++i];
      if (opts.repo === undefined) throw new Error('Missing value for --repo');
    } else if (arg.startsWith('--repo=')) {
      opts.repo = arg.slice('--repo='.length);
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

function envToken() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
}

async function githubRequest(method, route, token, body = null) {
  const response = await fetch(`${githubApi}${route}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'hello-cc-release-script'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail = data?.message ? `: ${data.message}` : '';
    const error = new Error(`GitHub API ${method} ${route} failed with ${response.status}${detail}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  const pkg = readPackageJson(repoRoot);
  const version = normalizeVersion(opts.version || pkg.version);
  const tag = `v${version}`;
  const repo = opts.repo || process.env.GITHUB_REPOSITORY || repoFromPackage(pkg);
  if (!repo) throw new Error('Missing repository; pass --repo OWNER/REPO');

  const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const body = releaseSection(changelog, version);
  const problems = validateReleaseSection(body, version);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
    return;
  }

  const payload = {
    tag_name: tag,
    name: tag,
    body,
    draft: false,
    prerelease: false
  };

  if (opts.dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dry_run: true,
      repo,
      tag,
      name: payload.name,
      body_length: body.length,
      body_preview: body.split(/\r?\n/).slice(0, 8).join('\n')
    }, null, 2));
    return;
  }

  const token = envToken();
  if (!token) throw new Error('Missing GH_TOKEN or GITHUB_TOKEN');

  let existing = null;
  try {
    existing = await githubRequest('GET', `/repos/${repo}/releases/tags/${tag}`, token);
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  const result = existing
    ? await githubRequest('PATCH', `/repos/${repo}/releases/${existing.id}`, token, payload)
    : await githubRequest('POST', `/repos/${repo}/releases`, token, payload);

  console.log(JSON.stringify({
    ok: true,
    action: existing ? 'updated' : 'created',
    repo,
    tag,
    url: result.html_url,
    body_length: body.length
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exitCode = 1;
});
