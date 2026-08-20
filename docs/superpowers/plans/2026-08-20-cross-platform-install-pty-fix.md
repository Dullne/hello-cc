# Cross-Platform Install And macOS PTY Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fresh Linux and macOS installations understandable and reliable, and make the macOS GitHub Actions PTY regression pass for the same reason real user installs pass.

**Architecture:** Pin the first reviewed official `node-pty` artifact whose Darwin helpers are published executable, and enforce that artifact contract in tests instead of mutating dependencies after installation. Keep tmux installation logic platform-specific but expose its decision functions for deterministic tests, then document Node.js, tmux, npm, WSL, verification, and uninstall flows consistently in English and Chinese.

**Tech Stack:** Node.js 24 ESM, npm/package-lock v3, node:test, node-pty, GitHub Actions, Markdown.

---

## File Map

- Modify `package.json`: exact `node-pty` dependency.
- Modify `package-lock.json`: exact resolved dependency and integrity.
- Modify `test/release-contract.test.mjs`: dependency version and Darwin helper mode contract.
- Create `test/tmux-install.test.mjs`: deterministic Linux/macOS package-manager selection tests.
- Modify `lib/terminal/tmux.mjs`: exported pure install hint/plan helpers and openSUSE support.
- Modify `README.md`: concise cross-platform prerequisites and installation matrix.
- Modify `README.zh-CN.md`: Chinese equivalent of the installation matrix.
- Modify `docs/guide.md`: detailed install, verification, permissions, WSL, update, and uninstall instructions.
- Modify `docs/guide.zh-CN.md`: Chinese equivalent of the detailed guide.
- Modify `CHANGELOG.md`: disclose the exact prerelease dependency and installation/documentation fix.
- Modify `.github/workflows/test.yml`: explicit dependency-contract and real-PTY checks before the full suite.

### Task 1: Pin The Fixed Darwin PTY Artifact

**Files:**
- Modify: `test/release-contract.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add the failing dependency contract test**

Add constants and a test to `test/release-contract.test.mjs`:

```js
const nodePtyVersion = '1.2.0-beta.15';

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
```

- [ ] **Step 2: Run the focused test to prove RED**

Run:

```bash
node --test test/release-contract.test.mjs
```

Expected: FAIL because `package.json`, the lockfile, and the installed package still resolve to `1.1.0`; at least the x64 Darwin helper is non-executable.

- [ ] **Step 3: Update the dependency under Node 24**

Run with Node 24 first in `PATH`:

```bash
npm install --save-exact node-pty@1.2.0-beta.15 --ignore-scripts=false --no-audit --no-fund
```

Expected: `package.json` contains exactly `"node-pty": "1.2.0-beta.15"`; the lockfile root and package entry match it.

- [ ] **Step 4: Run the dependency test to prove GREEN**

Run:

```bash
node --test test/release-contract.test.mjs
```

Expected: PASS, including both Darwin helper execute-bit assertions.

- [ ] **Step 5: Run the real PTY identity test**

Run:

```bash
node --test --test-name-pattern='captures a complete real PTY identity' test/process-identity.test.mjs
```

Expected: PASS with no `posix_spawnp failed`.

- [ ] **Step 6: Commit the dependency fix**

```bash
git add package.json package-lock.json test/release-contract.test.mjs
git commit -m "fix: pin executable macOS node-pty helpers"
```

### Task 2: Test And Complete Platform-Specific tmux Guidance

**Files:**
- Create: `test/tmux-install.test.mjs`
- Modify: `lib/terminal/tmux.mjs`

- [ ] **Step 1: Write failing pure selection tests**

Create `test/tmux-install.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmuxInstallHint, tmuxInstallPlan } from '../lib/terminal/tmux.mjs';

const available = (...names) => (name) => names.includes(name);
const noFiles = () => false;

test('Linux plans never use Homebrew', () => {
  for (const manager of ['apt-get', 'dnf', 'yum', 'apk', 'pacman', 'zypper']) {
    const plan = tmuxInstallPlan({
      platform: 'linux',
      commandAvailable: available(manager, 'sudo'),
      isRoot: false
    });
    assert.equal(plan.manager, manager);
    assert.doesNotMatch(plan.commands.join('\n'), /brew/);
  }
});

test('macOS uses Homebrew only when Homebrew is available', () => {
  assert.deepEqual(tmuxInstallPlan({
    platform: 'darwin', commandAvailable: available('brew'), isRoot: false
  }), { manager: 'brew', commands: ['brew install tmux'] });
  assert.equal(tmuxInstallPlan({
    platform: 'darwin', commandAvailable: available(), isRoot: false
  }), null);
});

test('Linux hints cover major package families and generic fallback', () => {
  assert.match(tmuxInstallHint({ platform: 'linux', pathExists: (p) => p === '/etc/debian_version' }), /apt-get/);
  assert.match(tmuxInstallHint({ platform: 'linux', pathExists: (p) => p === '/etc/alpine-release' }), /apk/);
  assert.match(tmuxInstallHint({ platform: 'linux', pathExists: (p) => p === '/etc/arch-release' }), /pacman/);
  assert.match(tmuxInstallHint({ platform: 'linux', pathExists: (p) => p === '/etc/fedora-release' }), /dnf/);
  assert.match(tmuxInstallHint({ platform: 'linux', pathExists: (p) => p === '/etc/SuSE-release' }), /zypper/);
  assert.match(tmuxInstallHint({ platform: 'linux', pathExists: noFiles }), /apt|dnf|yum|apk|pacman|zypper/);
  assert.doesNotMatch(tmuxInstallHint({ platform: 'linux', pathExists: noFiles }), /brew/);
});
```

- [ ] **Step 2: Run the new test to prove RED**

Run:

```bash
node --test test/tmux-install.test.mjs
```

Expected: FAIL because `tmuxInstallHint` is private, `tmuxInstallPlan` does not exist, and zypper is unsupported.

- [ ] **Step 3: Implement a pure install plan**

In `lib/terminal/tmux.mjs`, export `tmuxInstallHint` with injectable platform/path checks and add:

```js
export function tmuxInstallPlan({
  platform = process.platform,
  commandAvailable = commandExists,
  isRoot = typeof process.getuid === 'function' && process.getuid() === 0
} = {}) {
  if (platform === 'darwin') {
    return commandAvailable('brew')
      ? { manager: 'brew', commands: ['brew install tmux'] }
      : null;
  }
  if (platform !== 'linux') return null;

  const sudo = isRoot ? '' : (commandAvailable('sudo') ? 'sudo ' : '');
  if (commandAvailable('apt-get')) return {
    manager: 'apt-get',
    commands: [`${sudo}apt-get update`, `${sudo}apt-get install -y tmux`]
  };
  if (commandAvailable('dnf')) return { manager: 'dnf', commands: [`${sudo}dnf install -y tmux`] };
  if (commandAvailable('yum')) return { manager: 'yum', commands: [`${sudo}yum install -y tmux`] };
  if (commandAvailable('apk')) return { manager: 'apk', commands: [`${sudo}apk add tmux`] };
  if (commandAvailable('pacman')) return { manager: 'pacman', commands: [`${sudo}pacman -S --noconfirm tmux`] };
  if (commandAvailable('zypper')) return { manager: 'zypper', commands: [`${sudo}zypper --non-interactive install tmux`] };
  return null;
}
```

Make `tryInstallTmux()` consume the plan in order and stop at the first failed command. The generic Linux hint must list `apt`, `dnf`/`yum`, `apk`, `pacman`, and `zypper`, never Homebrew.

- [ ] **Step 4: Run focused tests to prove GREEN**

Run:

```bash
node --test test/tmux-install.test.mjs
node --test test/release-contract.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Verify the actual host hint and tmux path**

Run:

```bash
node -e "import('./lib/terminal/tmux.mjs').then((m) => console.log(m.tmuxInstallHint()))"
tmux -V
```

Expected on macOS: the hint mentions Homebrew and `tmux -V` succeeds. Linux behavior is proven by the injected tests and later container gate.

- [ ] **Step 6: Commit the CLI guidance**

```bash
git add lib/terminal/tmux.mjs test/tmux-install.test.mjs
git commit -m "fix: make tmux installation guidance platform-specific"
```

### Task 3: Document Universal Installation In English And Chinese

**Files:**
- Modify: `test/release-contract.test.mjs`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/guide.md`
- Modify: `docs/guide.zh-CN.md`

- [ ] **Step 1: Add failing documentation-contract assertions**

Add two tests to `test/release-contract.test.mjs`:

```js
test('English install docs cover supported platforms and verification', () => {
  const text = ['README.md', 'docs/guide.md'].map(read).join('\n');
  for (const expected of [
    /Node\.js 24/, /npm install -g @logicseek\/hello-cc/, /apt-get/, /dnf/,
    /yum/, /apk/, /pacman/, /zypper/, /brew install tmux/, /WSL/,
    /node --version[\s\S]*tmux -V[\s\S]*hcc --version/
  ]) assert.match(text, expected, `English install docs are missing ${expected}`);
  assert.match(text, /Linux[^.\n]*(?:system|distribution) package manager/i);
});

test('Chinese install docs cover supported platforms and verification', () => {
  const text = ['README.zh-CN.md', 'docs/guide.zh-CN.md'].map(read).join('\n');
  for (const expected of [
    /Node\.js 24/, /npm install -g @logicseek\/hello-cc/, /apt-get/, /dnf/,
    /yum/, /apk/, /pacman/, /zypper/, /brew install tmux/, /Linux/, /macOS/,
    /WSL/, /验证/, /node --version[\s\S]*tmux -V[\s\S]*hcc --version/
  ]) assert.match(text, expected, `Chinese install docs are missing ${expected}`);
  assert.match(text, /Linux[^。\n]*(?:系统|发行版)[^。\n]*包管理器[^。\n]*(?:而不是|不要使用|不使用)[^。\n]*Homebrew/);
});
```

- [ ] **Step 2: Run the contract test to prove RED**

Run:

```bash
node --test test/release-contract.test.mjs
```

Expected: FAIL because the current docs show npm installation but do not include the full platform matrix or verification flow.

- [ ] **Step 3: Expand both README installation sections**

Add a concise matrix containing:

```text
All platforms: install Node.js 24+, then npm install -g @logicseek/hello-cc
Debian/Ubuntu: sudo apt-get update && sudo apt-get install -y tmux
Fedora/RHEL: sudo dnf install -y tmux (yum on older systems)
Alpine: sudo apk add tmux
Arch: sudo pacman -S --needed tmux
openSUSE: sudo zypper install tmux
macOS only: brew install tmux
WSL: follow the Linux distribution instructions inside WSL
```

State that root shells omit `sudo`, Linux must not use Homebrew for this dependency, and npm `EACCES` should be solved with a Node version manager/user-owned prefix rather than `sudo npm install -g`.

- [ ] **Step 4: Expand both detailed user guides**

Add prerequisite, installation, no-global-install, verification, update, uninstall, and troubleshooting subsections. The verification block must be identical in meaning in both languages:

```bash
node --version
npm --version
tmux -V
hcc --version
hcc --help
```

State the expected Node major (`v24` or newer), that `hcc web` may auto-install tmux only when a supported package manager and sufficient privileges exist, and that manual installation is the deterministic route for servers/containers.

- [ ] **Step 5: Run documentation contracts to prove GREEN**

Run:

```bash
node --test test/release-contract.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Check bilingual command parity**

Run:

```bash
rg -n 'apt-get|dnf|yum|apk|pacman|zypper|brew install tmux|npm install -g|node --version|tmux -V|hcc --version' README.md README.zh-CN.md docs/guide.md docs/guide.zh-CN.md
```

Expected: every package-manager command and verification command appears in both languages; Homebrew is labeled macOS-only.

- [ ] **Step 7: Commit the documentation**

```bash
git add README.md README.zh-CN.md docs/guide.md docs/guide.zh-CN.md test/release-contract.test.mjs
git commit -m "docs: add cross-platform installation instructions"
```

### Task 4: Make CI Diagnose The PTY Contract Directly

**Files:**
- Modify: `.github/workflows/test.yml`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add focused CI gates before the full suite**

After `npm ci`, add:

```yaml
      - name: Verify install and PTY contract
        run: |
          node --test test/release-contract.test.mjs
          node --test --test-name-pattern='captures a complete real PTY identity' test/process-identity.test.mjs
```

Keep the existing Ubuntu/macOS matrix and full `npm test`. Do not skip the macOS PTY test and do not add a CI-only `chmod` workaround.

- [ ] **Step 2: Amend the 1.0.1 changelog**

Add bullets explaining that `node-pty` is exactly pinned to `1.2.0-beta.15` because stable `1.1.0` publishes non-executable Darwin helpers, that the macOS fresh-install PTY failure is fixed, and that Linux/macOS/WSL install instructions and package-manager hints are now explicit. Record the prerelease dependency as a bounded risk requiring exact pinning and full verification.

- [ ] **Step 3: Run workflow and release checks**

Run:

```bash
npm run release:check
npm run release:github:dry-run
git diff --check
```

Expected: all commands exit 0; the dry-run resolves `v1.0.1` and produces a non-empty release body.

- [ ] **Step 4: Commit CI and release notes**

```bash
git add .github/workflows/test.yml CHANGELOG.md
git commit -m "ci: verify fresh macOS PTY dependency contract"
```

### Task 5: Run The Complete Local Release Gate

**Files:**
- Verify only; do not modify source during this task.

- [ ] **Step 1: Run focused macOS PTY and install tests**

Run with Node 24:

```bash
node --test test/tmux-install.test.mjs test/release-contract.test.mjs
node --test --test-name-pattern='captures a complete real PTY identity' test/process-identity.test.mjs
```

Expected: all pass with no `posix_spawnp failed`.

- [ ] **Step 2: Run three complete macOS unit suites**

Run `npm run test:unit` three times sequentially. Expected each time: 0 failures; the only permitted skip is the existing platform-conditional lexical alias test.

- [ ] **Step 3: Run the complete macOS regression**

Run:

```bash
npm run test:regression
```

Expected: 13/13 and `FULL_REGRESSION_OK`.

- [ ] **Step 4: Run source and release gates**

Run:

```bash
npm run test:audit
npm run smoke
npm run release:check
npm run release:github:dry-run
npm publish --dry-run --registry=https://registry.npmjs.org/ --access public
git diff --check
```

Expected: every command exits 0; npm dry-run reports `@logicseek/hello-cc@1.0.1`.

- [ ] **Step 5: Build one immutable Linux image**

Run:

```bash
docker build --pull --no-cache -t hello-cc-1.0.1-install-pty .
docker image inspect hello-cc-1.0.1-install-pty --format '{{.Id}}'
```

Record the image ID. Expected base runtime: Node 24 and tmux.

- [ ] **Step 6: Run the same Linux image three times**

Run three sequential invocations:

```bash
docker run --rm hello-cc-1.0.1-install-pty
```

Expected each time: unit tests have 0 failures and regression ends 13/13 with `FULL_REGRESSION_OK`.

- [ ] **Step 7: Pack the final candidate once**

Create an empty temporary directory, run `npm pack --pack-destination <directory>`, and record the tarball SHA-256. Do not rebuild or repack between consumer checks.

- [ ] **Step 8: Verify two fresh macOS global installs of the same tarball**

Install once normally and once with `--ignore-scripts`, each into a unique empty prefix and cache under Node 24. For both installations, assert package version `1.0.1`, dependency version `1.2.0-beta.15`, both Darwin helper modes `0755`, CLI version/help, one real PTY, and 50 sequential real PTYs with clean exit.

- [ ] **Step 9: Verify the same tarball in a clean Linux Node 24 container**

Install the host tarball into a new `node:24` container, add tmux/build prerequisites using apt, and verify CLI help/version, one real PTY, schema-v7 database creation, Runtime API v2, and clean `hcc down`.

- [ ] **Step 10: Confirm final repository state**

Run:

```bash
git status --short --branch
git log --oneline origin/master..HEAD
git tag --points-at HEAD
```

Expected: clean working tree; commits are local until explicitly authorized for push; no new tag has been created.

### Task 6: Push And Review Remote CI Only After Explicit Approval

**Files:**
- No source modification.

- [ ] **Step 1: Re-fetch and prove there is no remote divergence**

Run `git fetch --tags origin`, then require `git rev-list --left-right --count origin/master...master` to report zero commits only on the remote side.

- [ ] **Step 2: Push master after explicit user approval**

Run `git push origin master`, then verify `git ls-remote origin refs/heads/master` equals local `HEAD`.

- [ ] **Step 3: Wait for the new Test workflow**

Read the workflow run for the pushed SHA. Require both `Regression (ubuntu-latest)` and `Regression (macos-latest)` to complete successfully. The old failed run remains historical evidence and is not rewritten.

- [ ] **Step 4: Stop before tag or npm publication**

Report local and remote verification evidence. Creating `v1.0.1`, updating a GitHub Release, and publishing npm remain separate irreversible actions requiring explicit authorization.
