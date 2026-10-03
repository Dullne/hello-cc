import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { CliError } from '../shared/errors.mjs';
import { preparePinnedCwdLaunch } from './pinned-cwd.mjs';

// The bootstrap enters the checked directory inode before this worker runs.
// All destructive names below are relative to that cwd, never to a project
// pathname that could have been rebound after validation.
function projectStateWorker() {
  const fs = require('node:fs');
  const mode = process.argv[1];
  const expected = JSON.parse(process.argv[2]);
  const content = process.argv[3] || '';
  const sameDirectory = (stat) => stat.isDirectory() &&
    stat.dev.toString() === expected.dev && stat.ino.toString() === expected.ino &&
    (expected.birthtimeNs === null ||
      stat.birthtimeNs?.toString() === expected.birthtimeNs);
  let fd;
  let temporary;
  try {
    if (mode === 'write-guidance') {
      if (!sameDirectory(fs.statSync('.', { bigint: true }))) {
        throw new Error('STATE_DIRECTORY_CHANGED');
      }
      temporary = `HCC.md.tmp.${process.pid}.${require('node:crypto').randomBytes(16).toString('hex')}`;
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT |
        fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      /* PINNED_STATE_TEST_BEFORE_RENAME */
      fs.renameSync(temporary, 'HCC.md');
    } else if (mode === 'purge-legacy') {
      const state = fs.lstatSync('.hello-cc', { bigint: true });
      if (!sameDirectory(state)) throw new Error('STATE_DIRECTORY_CHANGED');
      /* PINNED_STATE_TEST_BEFORE_PURGE */
      fs.rmSync('.hello-cc', { recursive: true, force: true });
    } else throw new Error('STATE_OPERATION_INVALID');
    process.stdout.write('ok');
  } catch (error) {
    process.stderr.write('HCC_PINNED_STATE_FAILED:' + (error?.code || error?.message || 'unknown') + '\n');
    process.exitCode = 1;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (temporary) {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
}

const PROJECT_STATE_WORKER_SOURCE = '(' + projectStateWorker.toString() + ')()';

function sameBinding(actual, expected) {
  return actual.identity.cwd === expected.canonical &&
    actual.identity.dev === expected.identity.dev &&
    actual.identity.ino === expected.identity.ino &&
    actual.identity.birthtimeNs === expected.identity.birthtimeNs;
}

function runPinnedStateWorker(cwd, mode, expectedCwd, targetIdentity, content, spawnProcess) {
  expectedCwd.assertUnchanged();
  const binding = preparePinnedCwdLaunch(cwd, process.execPath,
    ['-e', PROJECT_STATE_WORKER_SOURCE, mode, JSON.stringify(targetIdentity), content], {
      env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '', NODE_NO_WARNINGS: '1' }
    });
  try {
    if (!sameBinding(binding, expectedCwd)) {
      throw new CliError('PROJECT_PATH_CHANGED', 'Project state directory changed before pinned operation');
    }
    const result = spawnProcess(binding.command, binding.args, {
      cwd: binding.cwd, env: binding.env, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000, maxBuffer: 64 * 1024
    });
    if (result.error || result.status !== 0 || result.stdout !== 'ok') {
      const marker = String(result.stderr || '');
      if (/HCC_PINNED_CWD_CHANGED:|HCC_PINNED_STATE_FAILED:STATE_DIRECTORY_CHANGED/.test(marker)) {
        throw new CliError('PROJECT_PATH_CHANGED', 'Project state directory changed during pinned operation');
      }
      throw new CliError('PROJECT_STATE_OPERATION_FAILED',
        `Pinned project state operation failed: ${result.error?.code || marker.trim() || `exit ${result.status}`}`);
    }
  } finally { binding.release(); }
}

export function writePinnedProjectGuidance(stateDir, content, expectedState, {
  spawnProcess = spawnSync
} = {}) {
  runPinnedStateWorker(stateDir, 'write-guidance', expectedState, expectedState.identity,
    content, spawnProcess);
  return path.join(stateDir, 'HCC.md');
}

export function purgePinnedLegacyProjectState(root, stateDir, expectedRoot, expectedState, {
  spawnProcess = spawnSync
} = {}) {
  if (path.resolve(stateDir) !== path.join(expectedRoot.canonical, '.hello-cc')) {
    throw new CliError('PROJECT_PATH_FORBIDDEN', 'Legacy state is not under the selected project root');
  }
  expectedState.assertUnchanged();
  runPinnedStateWorker(root, 'purge-legacy', expectedRoot, expectedState.identity,
    '', spawnProcess);
  return stateDir;
}
