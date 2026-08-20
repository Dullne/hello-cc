import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const currentRelease = '1.0.1';

const englishDocs = ['README.md', 'docs/README.md', 'docs/commands.md', 'docs/guide.md'];
const chineseDocs = ['README.zh-CN.md', 'docs/README.zh-CN.md', 'docs/commands.zh-CN.md', 'docs/guide.zh-CN.md'];

test('current release metadata and Docker verification contract stay pinned', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const dockerfile = read('Dockerfile');
  assert.equal(pkg.version, currentRelease);
  assert.equal(lock.version, currentRelease);
  assert.equal(lock.packages[''].version, currentRelease);
  assert.match(dockerfile, /RUN npm ci --no-audit --no-fund/);
  assert.match(dockerfile, /node --version && tmux -V/);
  assert.doesNotMatch(dockerfile, /RUN npm install /);
});

test('English v1 user docs state breaking behavior and accepted risks', () => {
  for (const file of englishDocs) {
    const text = read(file);
    for (const expected of [
      /1\.0\.0/, /schema v7/i, /downgrad/i, /backup/i, /provider\s+peer\s+IDs?/i,
      /Runtime API v2/, /process[-\s]+evidence/i, /120/, /--history/, /--tls/,
      /--trust-proxy/, /plaintext/i, /existing server director(?:y|ies)/i
    ]) assert.match(text, expected, `${file} is missing ${expected}`);
  }
});

test('Chinese v1 user docs state breaking behavior and accepted risks', () => {
  for (const file of chineseDocs) {
    const text = read(file);
    for (const expected of [
      /1\.0\.0/, /schema v7/i, /不支持降级/, /备份/, /provider\s+peer\s+IDs?/i,
      /Runtime API v2/, /进程\s*证据/, /120/, /--history/, /--tls/,
      /--trust-proxy/, /明文/, /任意\s*已存在[\s\S]*目录/
    ]) assert.match(text, expected, `${file} is missing ${expected}`);
  }
});

test('CLI help and changelog expose the same v1 boundaries', () => {
  const help = execFileSync(process.execPath, [path.join(repoRoot, 'bin', 'hcc.mjs'), 'web', '--help'], {
    encoding: 'utf8'
  });
  const changelog = read('CHANGELOG.md');
  for (const expected of [
    /1\.0\.0/, /schema v7/i, /no\s+downgrade/i, /pre-migration backup/i,
    /provider peer ID/i, /Runtime API v2/, /process evidence/i, /120-second/,
    /--history/, /--tls/, /--trust-proxy/, /plaintext/i, /existing server directory/i
  ]) assert.match(help, expected);
  assert.match(changelog, /## 1\.0\.1/);
  assert.match(changelog, /## 1\.0\.0/);
  assert.match(changelog, /### Accepted Risks/);
  assert.match(changelog, /no automatic\s+alias, graph rewrite, or migration/i);
});
