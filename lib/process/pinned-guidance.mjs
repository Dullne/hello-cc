import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { CliError } from '../shared/errors.mjs';
import { preparePinnedCwdLaunch } from './pinned-cwd.mjs';
import { assertSelectedCwdSnapshot } from './selected-cwd-identity.mjs';

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
  const binding = preparePinnedCwdLaunch(root, process.execPath,
    ['-e', GUIDANCE_WORKER_SOURCE, mode, content], {
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

export function writeProjectGuidanceFiles(root, content, options = {}) {
  return runPinnedGuidance(root, 'write', content, options);
}

export function removeProjectGuidanceFiles(root, options = {}) {
  return runPinnedGuidance(root, 'remove', '', options);
}
