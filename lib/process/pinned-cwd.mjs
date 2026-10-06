import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CliError } from '../shared/errors.mjs';
import { ensurePrivateGlobalSubdirectory } from '../runtime/private-state.mjs';
import { stableProjectStateRoot } from '../runtime/project-trust.mjs';

// This function is serialized into node -e. Keep it self-contained: loading a
// script from the selected project before checking its identity would recreate
// the directory-rebind race that this bootstrap is intended to narrow.
function pinnedBootstrap() {
  const fs = require('node:fs');
  const path = require('node:path');
  const config = JSON.parse(process.argv[1]);
  const identity = config.identity;
  const changed = (stage) => {
    process.stderr.write('HCC_PINNED_CWD_CHANGED:' + stage + '\n');
    process.exit(stage === 'entry' ? 41 : 42);
  };
  const matches = (stat) => stat.isDirectory() &&
    stat.dev.toString() === identity.dev &&
    stat.ino.toString() === identity.ino &&
    (identity.birthtimeNs === null ||
      stat.birthtimeNs?.toString() === identity.birthtimeNs);

  let fd;
  let opened;
  try {
    fd = fs.openSync(identity.cwd,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    opened = fs.fstatSync(fd, { bigint: true });
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (identity.mode !== 'stat-only' || error?.code !== 'EACCES') changed('entry');
    fd = undefined;
    try { opened = fs.statSync(identity.cwd, { bigint: true }); }
    catch { changed('entry'); }
  }
  if (!matches(opened)) changed('entry');
  /* PINNED_TEST_AFTER_OPEN */
  try { process.chdir(identity.cwd); }
  catch { changed('chdir'); }
  let current;
  try { current = fs.statSync('.', { bigint: true }); }
  catch { changed('chdir'); }
  if (!matches(current) ||
      (fd !== undefined &&
        (current.dev !== opened.dev || current.ino !== opened.ino))) changed('chdir');
  if (fd !== undefined) fs.closeSync(fd);
  if (config.ack) {
    let ackFd;
    try {
      ackFd = fs.openSync(config.ack.path,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
        0o600);
      const bytes = Buffer.from(config.ack.nonce);
      let offset = 0;
      while (offset < bytes.length) offset += fs.writeSync(ackFd, bytes, offset, bytes.length - offset);
      fs.closeSync(ackFd);
      ackFd = undefined;
    } catch (error) {
      if (ackFd !== undefined) fs.closeSync(ackFd);
      process.stderr.write('HCC_PINNED_ACK_FAILED:' + (error?.code || 'unknown') + '\n');
      process.exit(43);
    }
  }
  /* PINNED_TEST_BEFORE_EXEC */

  const env = { ...process.env };
  if (config.nodeOptions !== null) env.NODE_OPTIONS = config.nodeOptions;
  try { env.PWD = process.cwd(); } catch { changed('chdir'); }
  const command = config.command;
  const fromPinnedCwd = (candidate) => {
    if (!path.isAbsolute(candidate)) return candidate;
    for (const root of [identity.cwd, identity.requestedCwd]) {
      const relative = path.relative(root, candidate);
      if (relative === '') return '.';
      if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
        return '.' + path.sep + relative;
      }
    }
    return candidate;
  };
  let executable;
  if (command.includes('/')) {
    executable = fromPinnedCwd(command);
  } else {
    const search = env.PATH === undefined ? '/usr/bin:/bin' : env.PATH;
    for (const entry of search.split(path.delimiter)) {
      const candidate = fromPinnedCwd(path.join(entry || '.', command));
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) { executable = candidate; break; }
      } catch {}
    }
  }
  if (!executable || typeof process.execve !== 'function') {
    process.stderr.write('HCC_PINNED_EXEC_FAILED:unavailable\n');
    process.exit(127);
  }
  let execArgs = [command, ...config.args];
  // Node 24's experimental execve aborts the process (rather than throwing)
  // for ENOEXEC. Handle plain executable text without a shebang before execve:
  // Linux ordinary spawn runs it via /bin/sh, whereas macOS rejects it.
  try {
    const probeFd = fs.openSync(executable, fs.constants.O_RDONLY);
    try {
      const prefix = Buffer.alloc(128);
      const length = fs.readSync(probeFd, prefix, 0, prefix.length, 0);
      const plainText = length > 0 && prefix.subarray(0, length).every(
        byte => (byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d);
      if (plainText && !(prefix[0] === 0x23 && prefix[1] === 0x21)) {
        if (process.platform === 'linux') {
          // Linux's ordinary Node spawn uses the POSIX shell fallback for an
          // executable text file without a shebang. Preserve that behavior
          // without asking Node's aborting execve to handle ENOEXEC.
          try { fs.accessSync(executable, fs.constants.X_OK); }
          catch {
            process.stderr.write('HCC_PINNED_EXEC_FAILED:EACCES\n');
            process.exit(127);
          }
          execArgs = ['sh', executable, ...config.args];
          executable = '/bin/sh';
        } else {
          process.stderr.write('HCC_PINNED_EXEC_FAILED:ENOEXEC\n');
          process.exit(127);
        }
      }
    } finally { fs.closeSync(probeFd); }
  } catch (error) {
    if (error?.code !== 'EACCES') {
      process.stderr.write('HCC_PINNED_EXEC_FAILED:' + (error?.code || 'unknown') + '\n');
      process.exit(127);
    }
  }
  try { process.execve(executable, execArgs, env); }
  catch (error) {
    process.stderr.write('HCC_PINNED_EXEC_FAILED:' + (error?.code || 'unknown') + '\n');
    process.exit(127);
  }
}

export const PINNED_CWD_BOOTSTRAP_SOURCE = '(' + pinnedBootstrap.toString() + ')()';

export const PINNED_LAUNCH_MODE_ENV = 'HCC_PINNED_LAUNCH_MODE';

export function assertPinnedSessionLaunchAllowed(options = {}) {
  if (options.purpose === 'maintenance') return;
  // Provider child environments may deliberately strip HCC_* variables. The
  // parent rollout setting must still govern the launch in that case; a
  // per-launch environment can only make the gate stricter, never clear it.
  const modes = [process.env[PINNED_LAUNCH_MODE_ENV], options.env?.[PINNED_LAUNCH_MODE_ENV]]
    .filter(value => value !== undefined && value !== '');
  if (modes.some(mode => mode !== 'pinned' && mode !== 'hold')) {
    throw new CliError('PINNED_LAUNCH_MODE_INVALID',
      `${PINNED_LAUNCH_MODE_ENV} must be pinned or hold`);
  }
  if (modes.includes('hold')) {
    throw new CliError('PINNED_LAUNCH_PAUSED',
      'New session launches are paused; existing processes remain running');
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs;
}

function directoryIdentity(stat, cwd, requestedCwd, mode) {
  return {
    cwd,
    requestedCwd,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs?.toString() || null,
    mode
  };
}

function bootstrapDirectory(override) {
  if (override !== undefined) {
    const trusted = stableProjectStateRoot(override);
    if (!trusted) throw new CliError('PROJECT_PATH_FORBIDDEN', 'Bootstrap cwd must have stable trusted ancestry');
    return trusted;
  }
  return ensurePrivateGlobalSubdirectory('launches');
}

// Capture a directory descriptor for helpers that can pass it across a
// process boundary with SCM_RIGHTS. Unlike the Node bootstrap, the consumer
// never has to resolve the pathname again after this function returns.
export function captureTrustedDirectoryFd(cwd, expectedIdentity = null) {
  assertPinnedSessionLaunchAllowed();
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new CliError('PINNED_CWD_UNAVAILABLE', 'Trusted directory handoff requires macOS or Linux');
  }
  const requested = path.resolve(cwd);
  let canonical;
  try { canonical = fs.realpathSync.native(requested); }
  catch { throw new CliError('PROJECT_PATH_FORBIDDEN', 'Selected working directory is unavailable'); }

  let fd;
  try {
    fd = fs.openSync(canonical,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd, { bigint: true });
    const current = fs.statSync(requested, { bigint: true });
    if (!stat.isDirectory() || !sameIdentity(stat, current)) {
      throw new CliError('PROJECT_PATH_CHANGED', 'Selected working directory changed during capture');
    }
    const identity = directoryIdentity(stat, canonical, requested, 'descriptor');
    if (expectedIdentity &&
        (identity.cwd !== expectedIdentity.canonical ||
          identity.dev !== expectedIdentity.identity?.dev ||
          identity.ino !== expectedIdentity.identity?.ino ||
          identity.birthtimeNs !== expectedIdentity.identity?.birthtimeNs)) {
      throw new CliError('PROJECT_PATH_CHANGED', 'Selected working directory changed before launch');
    }
    return {
      fd,
      identity,
      release() {
        if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
      }
    };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error instanceof CliError) throw error;
    throw new CliError('PROJECT_PATH_FORBIDDEN', 'Selected working directory cannot be pinned');
  }
}

function acknowledgementState(ack) {
  if (!ack) return null;
  let fd;
  try {
    fd = fs.openSync(ack.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size !== ack.nonce.length) return null;
    if (fs.readFileSync(fd, 'utf8') !== ack.nonce) return null;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function removeOwnedAcknowledgement(ack) {
  const owned = acknowledgementState(ack);
  if (!owned) return;
  try {
    const current = fs.lstatSync(ack.path);
    if (current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(ack.path);
  } catch {}
}

// The returned binding deliberately retains its directory FD. Call release()
// only when the child has established its cwd or exited; retaining it while a
// child starts prevents inode reuse from satisfying a stale dev/ino snapshot.
export function preparePinnedCwdLaunch(cwd, command, args = [], options = {}) {
  assertPinnedSessionLaunchAllowed(options);
  if (process.platform === 'win32') {
    throw new CliError('PINNED_CWD_UNAVAILABLE', 'Pinned cwd launch requires POSIX directory identity');
  }
  if (typeof command !== 'string' || !command || !Array.isArray(args) ||
      args.some(arg => typeof arg !== 'string')) {
    throw new CliError('BAD_ARGS', 'Pinned launch requires a command and string arguments');
  }
  const requested = path.resolve(cwd);
  let canonical;
  try { canonical = fs.realpathSync.native(requested); }
  catch { throw new CliError('PROJECT_PATH_FORBIDDEN', 'Selected working directory is unavailable'); }

  let fd;
  let stat;
  let mode = 'descriptor';
  try {
    fd = fs.openSync(canonical,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    stat = fs.fstatSync(fd, { bigint: true });
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fd = undefined;
    if (error?.code !== 'EACCES') {
      throw new CliError('PROJECT_PATH_FORBIDDEN', 'Selected working directory cannot be pinned');
    }
    mode = 'stat-only';
    try { stat = fs.statSync(canonical, { bigint: true }); }
    catch { throw new CliError('PROJECT_PATH_FORBIDDEN', 'Selected working directory is unavailable'); }
  }
  try {
    const current = fs.statSync(requested, { bigint: true });
    if (!stat.isDirectory() || !sameIdentity(stat, current)) {
      throw new CliError('PROJECT_PATH_FORBIDDEN', 'Selected working directory changed during capture');
    }
    const env = { ...(options.env || process.env) };
    const nodeOptions = Object.hasOwn(env, 'NODE_OPTIONS') ? String(env.NODE_OPTIONS) : null;
    delete env.NODE_OPTIONS;
    const identity = directoryIdentity(stat, canonical, requested, mode);
    if (options.expectedIdentity &&
        (identity.cwd !== options.expectedIdentity.canonical ||
          identity.dev !== options.expectedIdentity.identity?.dev ||
          identity.ino !== options.expectedIdentity.identity?.ino ||
          identity.birthtimeNs !== options.expectedIdentity.identity?.birthtimeNs)) {
      throw new CliError('PROJECT_PATH_CHANGED', 'Selected working directory changed before launch');
    }
    const trustedCwd = bootstrapDirectory(options.bootstrapCwd);
    const ack = options.acknowledge === true ? {
      path: path.join(trustedCwd, 'ack-' + randomBytes(16).toString('hex')),
      nonce: randomBytes(32).toString('hex')
    } : null;
    const config = { identity, command, args, nodeOptions, ack };
    return {
      command: process.execPath,
      args: ['-e', PINNED_CWD_BOOTSTRAP_SOURCE, JSON.stringify(config)],
      cwd: trustedCwd,
      env,
      identity,
      ackPath: ack?.path || null,
      acknowledged() { return acknowledgementState(ack) !== null; },
      release() {
        if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
        removeOwnedAcknowledgement(ack);
      }
    };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    throw error;
  }
}

export function spawnPinnedCwdProcess(command, args, options = {}, spawnProcess = spawn) {
  const binding = preparePinnedCwdLaunch(options.cwd, command, args,
    { env: options.env, expectedIdentity: options.expectedIdentity });
  const { cwd, env, expectedIdentity, ...rest } = options;
  try {
    const child = spawnProcess(binding.command, binding.args, {
      ...rest, cwd: binding.cwd, env: binding.env
    });
    child.once('exit', binding.release);
    child.once('error', binding.release);
    return child;
  } catch (error) {
    binding.release();
    throw error;
  }
}

export function spawnPinnedCwdPty(pty, command, args, options = {}) {
  const binding = preparePinnedCwdLaunch(options.cwd, command, args,
    { env: options.env, expectedIdentity: options.expectedIdentity });
  const { cwd, env, expectedIdentity, ...rest } = options;
  try {
    const child = pty.spawn(binding.command, binding.args, {
      ...rest, cwd: binding.cwd, env: binding.env
    });
    child.onExit(() => binding.release());
    return child;
  } catch (error) {
    binding.release();
    throw error;
  }
}
