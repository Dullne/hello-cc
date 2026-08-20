import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const currentRelease = '1.0.1';
const nodePtyVersion = '1.2.0-beta.15';

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

test('node-pty is exactly pinned with executable Darwin helpers', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const installedPkg = JSON.parse(read('node_modules/node-pty/package.json'));

  assert.equal(pkg.dependencies['node-pty'], nodePtyVersion);
  assert.equal(lock.packages[''].dependencies['node-pty'], nodePtyVersion);
  assert.equal(lock.packages['node_modules/node-pty'].version, nodePtyVersion);
  assert.equal(installedPkg.version, nodePtyVersion);

  for (const arch of ['arm64', 'x64']) {
    const helper = path.join(repoRoot, 'node_modules', 'node-pty', 'prebuilds', `darwin-${arch}`, 'spawn-helper');
    const stat = fs.lstatSync(helper);
    assert.equal(stat.isFile(), true, `${arch} helper must be a regular file`);
    assert.equal(stat.isSymbolicLink(), false, `${arch} helper must not be a symlink`);
    assert.equal(stat.mode & 0o111, 0o111, `${arch} helper must be executable by all users`);
  }
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

test('English install docs cover supported platforms and verification', () => {
  const text = ['README.md', 'docs/guide.md'].map(read).join('\n');
  for (const expected of [
    /Node\.js 24/, /npm install -g @logicseek\/hello-cc/, /apt-get/, /dnf/,
    /yum install/, /apk/, /pacman/, /zypper/, /brew install tmux/, /WSL/,
    /node --version[\s\S]*tmux -V[\s\S]*hcc --version/
  ]) assert.match(text, expected, `English install docs are missing ${expected}`);
  assert.match(text, /Linux[^.\n]*(?:system|distribution) package manager/i);
});

test('Chinese install docs cover supported platforms and verification', () => {
  const text = ['README.zh-CN.md', 'docs/guide.zh-CN.md'].map(read).join('\n');
  for (const expected of [
    /Node\.js 24/, /npm install -g @logicseek\/hello-cc/, /apt-get/, /dnf/,
    /yum install/, /apk/, /pacman/, /zypper/, /brew install tmux/, /Linux/, /macOS/,
    /WSL/, /验证/, /node --version[\s\S]*tmux -V[\s\S]*hcc --version/
  ]) assert.match(text, expected, `Chinese install docs are missing ${expected}`);
  assert.match(text, /Linux[^。\n]*(?:系统|发行版)[^。\n]*包管理器[^。\n]*(?:而不是|不要使用|不使用)[^。\n]*Homebrew/);
});

test('CI and 1.0.1 notes expose the macOS PTY packaging contract', () => {
  const workflow = read('.github/workflows/test.yml');
  const releaseNotes = read('CHANGELOG.md').split('## 1.0.0')[0];

  assert.match(workflow, /name: Verify install and PTY contract/);
  assert.match(workflow, /node --test test\/release-contract\.test\.mjs/);
  assert.match(workflow, /captures a complete real PTY identity/);
  assert.doesNotMatch(workflow, /chmod/);
  assert.match(releaseNotes, /node-pty.*1\.2\.0-beta\.15/is);
  assert.match(releaseNotes, /1\.1\.0.*non-executable Darwin helpers/is);
  assert.match(releaseNotes, /exact(?:ly)? pin/i);
  assert.match(releaseNotes, /Linux.*macOS.*WSL/is);
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
