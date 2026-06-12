#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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

function normalizeVersion(version) {
  return String(version || '').replace(/^v/, '');
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

function repoFromPackage(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!repo) return null;
  const match = repo.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/);
  return match ? match[1] : null;
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

  const pkg = readJson(path.join(repoRoot, 'package.json'));
  const version = normalizeVersion(opts.version || pkg.version);
  const tag = `v${version}`;
  const repo = opts.repo || process.env.GITHUB_REPOSITORY || repoFromPackage(pkg);
  if (!repo) throw new Error('Missing repository; pass --repo OWNER/REPO');

  const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const body = releaseSection(changelog, version);
  const problems = validateSection(body, version);
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
