import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CliError } from '../shared/errors.mjs';
import { preparePinnedCwdLaunch } from './pinned-cwd.mjs';
import { assertSelectedCwdSnapshot, sameSelectedCwdIdentity } from './selected-cwd-identity.mjs';
import { captureDirectory } from '../platform/windows-filesystem.mjs';

// This worker only uses relative names after the bootstrap has entered the
// selected directory inode. It cannot follow a rebound absolute project path.
function guidanceWorker() {
  const fs = require('node:fs');
  const files = ['CLAUDE.md', 'AGENTS.md'];
  const mode = process.argv[1];
  const content = process.argv[2] || '';
  const clause = '\n<!-- hello-cc:start -->\n\n' + content + '\n<!-- hello-cc:end -->\n';
  const changed = [];
  const opened = [];

  function readTarget(name) {
    let fd;
    try { fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) {
      if (error?.code === 'ENOENT') return { name, fd: null, text: null };
      throw error;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('GUIDANCE_FILE_UNSAFE');
      const text = fs.readFileSync(fd, 'utf8');
      return { name, fd, text, dev: stat.dev, ino: stat.ino };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  function writeTarget(target, text) {
    let fd = null;
    try {
      if (target.fd === null) {
        fd = fs.openSync(target.name,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, 0o644);
      } else {
        fd = fs.openSync(target.name, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== target.dev || stat.ino !== target.ino) {
          throw new Error('GUIDANCE_FILE_CHANGED');
        }
      }
      const bytes = Buffer.from(text);
      let offset = 0;
      while (offset < bytes.length) {
        offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      }
      fs.ftruncateSync(fd, bytes.length);
      fs.fsyncSync(fd);
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  try {
    // Inspect both targets before the first write, so a pre-existing symlink
    // or hardlink cannot lead to a partial ordinary guidance installation.
    for (const name of files) opened.push(readTarget(name));
    for (const target of opened) {
      if (mode === 'write') {
        const updated = target.text === null ? clause.trimStart() :
          target.text.includes('<!-- hello-cc:start -->')
            ? target.text.replace(/<!-- hello-cc:start -->[\s\S]*?<!-- hello-cc:end -->/, clause.trim())
            : target.text.trimEnd() + '\n' + clause;
        if (updated !== target.text) { writeTarget(target, updated); changed.push(target.name); }
      } else if (mode === 'remove') {
        if (target.text === null) continue;
        const updated = target.text
          .replace(/\n?<!-- hello-cc:start -->[\s\S]*?<!-- hello-cc:end -->\n?/g, '\n')
          .replace(/\n{3,}/g, '\n\n').trimEnd();
        const result = updated ? updated + '\n' : '';
        if (result !== target.text) { writeTarget(target, result); changed.push(target.name); }
      } else throw new Error('GUIDANCE_MODE_INVALID');
    }
    process.stdout.write(JSON.stringify(changed));
  } catch (error) {
    process.stderr.write('HCC_GUIDANCE_FAILED:' + (error?.code || error?.message || 'unknown') + '\n');
    process.exitCode = 1;
  } finally {
    for (const target of opened) if (target.fd !== null) fs.closeSync(target.fd);
  }
}

const GUIDANCE_WORKER_SOURCE = '(' + guidanceWorker.toString() + ')()';

function runPinnedGuidance(root, mode, content = '', {
  spawnProcess = spawnSync, expectedBinding = null, expectedSnapshot = null
} = {}) {
  expectedBinding?.assertUnchanged();
  if (expectedSnapshot) assertSelectedCwdSnapshot(expectedSnapshot);
  if (process.platform === 'win32') return runWindowsGuidance(root, mode, content,
    { expectedBinding, expectedSnapshot });
  const binding = preparePinnedCwdLaunch(root, process.execPath,
    ['-e', GUIDANCE_WORKER_SOURCE, mode, content], {
      purpose: 'maintenance',
      // The worker needs only built-ins. Do not permit inherited Node preload
      // hooks to run before it can operate on relative names.
      env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '', NODE_NO_WARNINGS: '1' }
    });
  try {
    const expected = expectedBinding || expectedSnapshot;
    if (expected && (binding.identity.cwd !== expected.canonical ||
        binding.identity.dev !== expected.identity.dev ||
        binding.identity.ino !== expected.identity.ino ||
        binding.identity.birthtimeNs !== expected.identity.birthtimeNs)) {
      throw new CliError('PROJECT_PATH_CHANGED', 'Selected working directory changed before guidance update');
    }
    const result = spawnProcess(binding.command, binding.args, {
      cwd: binding.cwd, env: binding.env, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 64 * 1024
    });
    if (result.error || result.status !== 0) {
      const marker = String(result.stderr || '');
      if (/HCC_PINNED_CWD_CHANGED:/.test(marker)) {
        throw new CliError('PROJECT_PATH_CHANGED', 'Selected working directory changed before guidance update');
      }
      throw new CliError('GUIDANCE_WRITE_FAILED',
        `Cannot ${mode} project guidance: ${result.error?.code || marker.trim() || `exit ${result.status}`}`);
    }
    const changed = JSON.parse(result.stdout || '[]');
    if (!Array.isArray(changed) || changed.some(name => !['CLAUDE.md', 'AGENTS.md'].includes(name))) {
      throw new CliError('GUIDANCE_WRITE_FAILED', 'Guidance worker returned an invalid receipt');
    }
    return changed.map(name => `${binding.identity.cwd}/${name}`);
  } finally { binding.release(); }
}

function withWindowsGuidanceDirectory(root, expected, fn) {
  const canonical = fs.realpathSync.native(path.resolve(root));
  const lease = captureDirectory(canonical);
  let directory;
  try {
    const snapshot = lease.snapshot();
    if (expected && !sameSelectedCwdIdentity(snapshot, expected)) {
      throw new CliError('PROJECT_PATH_CHANGED', 'Selected working directory changed before guidance update');
    }
    directory = lease.openDirectory('');
    const result = fn(directory, snapshot.canonical);
    directory.assertUnchanged();
    return result;
  } finally { directory?.close(); lease.close(); }
}

function readWindowsGuidanceTarget(directory, name, { privateFile = false } = {}) {
  let handle;
  try { handle = directory.openFile(name); }
  catch (error) { if (error?.code === 'PROJECT_FILE_NOT_FOUND') return { name, bytes: null, identity: null }; throw error; }
  try {
    const snapshot = handle.snapshot();
    if (snapshot.nlink !== '1' || BigInt(snapshot.size) > 10n * 1024n * 1024n) {
      throw new CliError('GUIDANCE_WRITE_FAILED', 'Guidance must be a bounded single-link regular file');
    }
    if (privateFile && handle.security().private !== true) throw new CliError('PROJECT_PATH_FORBIDDEN', 'Private guidance file is not private');
    const bytes = handle.read(10 * 1024 * 1024);
    // Refuse lossy text rewrites that could silently alter unrelated bytes.
    if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new CliError('GUIDANCE_WRITE_FAILED', 'Guidance must use valid UTF-8');
    return { name, bytes, identity: snapshot.identity };
  } finally { handle.close(); }
}

function publishWindowsGuidanceTarget(directory, target, bytes, privateFile = false) {
  return directory.publish(target.name, bytes, { operation: target.bytes === null ? 'create' : 'replace',
    private: privateFile, ...(target.bytes === null ? {} : { expectedIdentity: target.identity, expectedBytes: target.bytes }) });
}

function runWindowsGuidance(root, mode, content, { expectedBinding, expectedSnapshot }) {
  try {
    return withWindowsGuidanceDirectory(root, expectedBinding || expectedSnapshot, (directory, canonical) => {
      const targets = ['CLAUDE.md', 'AGENTS.md'].map(name => readWindowsGuidanceTarget(directory, name));
      const clause = '\n<!-- hello-cc:start -->\n\n' + content + '\n<!-- hello-cc:end -->\n';
      const changed = [];
      for (const target of targets) {
        const text = target.bytes?.toString('utf8') ?? null;
        let updated;
        if (mode === 'write') updated = text === null ? clause.trimStart() :
          text.includes('<!-- hello-cc:start -->')
            ? text.replace(/<!-- hello-cc:start -->[\s\S]*?<!-- hello-cc:end -->/, clause.trim())
            : text.trimEnd() + '\n' + clause;
        else if (mode === 'remove') {
          if (text === null) continue;
          const removed = text.replace(/\n?<!-- hello-cc:start -->[\s\S]*?<!-- hello-cc:end -->\n?/g, '\n')
            .replace(/\n{3,}/g, '\n\n').trimEnd();
          updated = removed ? removed + '\n' : '';
        } else throw new CliError('BAD_ARGS', 'Unknown guidance operation');
        if (updated === text) continue;
        expectedBinding?.assertUnchanged();
        if (expectedSnapshot) assertSelectedCwdSnapshot(expectedSnapshot);
        publishWindowsGuidanceTarget(directory, target, Buffer.from(updated));
        changed.push(path.join(canonical, target.name));
      }
      return changed;
    });
  } catch (error) {
    if (['PROJECT_PATH_CHANGED', 'PROJECT_FILE_CONFLICT', 'PROJECT_FILE_WRITE_UNCONFIRMED', 'WINDOWS_NATIVE_UNAVAILABLE'].includes(error?.code)) throw error;
    if (error?.code === 'GUIDANCE_WRITE_FAILED') throw error;
    throw new CliError('GUIDANCE_WRITE_FAILED', `Cannot ${mode} project guidance`, { reason: error?.code });
  }
}

export function writeWindowsPrivateGuidance(stateDir, content, expectedState) {
  expectedState.assertUnchanged();
  return withWindowsGuidanceDirectory(stateDir, expectedState, (directory, canonical) => {
    if (directory.security().private !== true) throw new CliError('PROJECT_PATH_FORBIDDEN', 'Private guidance directory is not private');
    const target = readWindowsGuidanceTarget(directory, 'HCC.md', { privateFile: true });
    const bytes = Buffer.from(content);
    if (target.bytes === null || !target.bytes.equals(bytes)) publishWindowsGuidanceTarget(directory, target, bytes, true);
    expectedState.assertUnchanged();
    return path.join(canonical, 'HCC.md');
  });
}

export function writeProjectGuidanceFiles(root, content, options = {}) {
  return runPinnedGuidance(root, 'write', content, options);
}

export function removeProjectGuidanceFiles(root, options = {}) {
  return runPinnedGuidance(root, 'remove', '', options);
}
