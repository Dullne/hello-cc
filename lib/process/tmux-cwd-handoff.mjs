import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CliError } from '../shared/errors.mjs';
import { assertPinnedSessionLaunchAllowed, captureTrustedDirectoryFd } from './pinned-cwd.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BROKER_TIMEOUT_MS = 25_000;
const BIND_TIMEOUT_MS = 6_000;
const bindSleep = new Int32Array(new SharedArrayBuffer(4));

function writeBrokerAuthorizationSync(broker, message) {
  // The Web launch API is synchronous. A Writable.end(message) can queue its
  // pipe write on the Node event loop, which is blocked while waiting for the
  // native bind receipt. Require an actual child-stdin descriptor and send the
  // tiny ALLOW line synchronously; if this Node runtime stops exposing it,
  // refuse the launch rather than hang or admit an unbound pane.
  const fd = broker.stdin?._handle?.fd;
  if (!Number.isSafeInteger(fd) || fd < 0) {
    throw new CliError('PINNED_CWD_UNAVAILABLE', 'Trusted tmux broker stdin is unavailable');
  }
  const bytes = Buffer.from(message, 'ascii');
  const deadline = Date.now() + 250;
  let offset = 0;
  while (offset < bytes.length) {
    try {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('Broker authorization pipe made no progress');
      offset += written;
    } catch (error) {
      if (!['EAGAIN', 'EINTR'].includes(error?.code) || Date.now() >= deadline) {
        throw new CliError('PINNED_CWD_UNAVAILABLE',
          'Could not authorize the trusted tmux broker synchronously');
      }
      Atomics.wait(bindSleep, 0, 0, 5);
    }
  }
  broker.stdin.end();
}

function killStartedBroker(broker) {
  // ChildProcess.kill() is unsafe for a failed spawn with pid === undefined:
  // some Node/libuv versions may signal the calling process instead.
  if (Number.isSafeInteger(broker?.pid) && broker.pid > 0 &&
      broker.exitCode === null && broker.signalCode === null) broker.kill();
}

export function trustedCwdHandoffBinary() {
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new CliError('PINNED_CWD_UNAVAILABLE', 'Trusted tmux directory handoff requires macOS or Linux');
  }
  const binary = path.join(packageRoot, 'native', 'bin',
    `${process.platform}-${process.arch}`, 'hcc-cwd-handoff');
  let stat;
  try { stat = fs.lstatSync(binary); }
  catch {
    throw new CliError('PINNED_CWD_UNAVAILABLE',
      `Trusted tmux directory helper is not packaged for ${process.platform}-${process.arch}`);
  }
  if (!stat.isFile() || (stat.mode & 0o022) !== 0) {
    throw new CliError('PINNED_CWD_UNAVAILABLE', 'Trusted tmux directory helper is unsafe');
  }
  try { fs.accessSync(binary, fs.constants.X_OK); }
  catch { throw new CliError('PINNED_CWD_UNAVAILABLE', 'Trusted tmux directory helper is not executable'); }
  // A source checkout can contain an old prebuilt helper after a C edit. The
  // release gate checks all four targets; also fail closed during local use.
  try {
    const source = fs.readFileSync(path.join(packageRoot, 'native', 'cwd-handoff', 'hcc-cwd-handoff.c'));
    const marker = Buffer.from('HCC_SOURCE_SHA256:' + createHash('sha256').update(source).digest('hex'));
    if (!fs.readFileSync(binary).includes(marker)) throw new Error('source hash mismatch');
  } catch {
    throw new CliError('PINNED_CWD_UNAVAILABLE', 'Trusted tmux directory helper does not match packaged source');
  }
  return binary;
}

function removeOwnedSocketDirectory(directory, identity) {
  try {
    const current = fs.lstatSync(directory);
    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) return;
    const socket = path.join(directory, 's');
    try {
      if (fs.lstatSync(socket).isSocket()) fs.unlinkSync(socket);
    } catch (error) { if (error?.code !== 'ENOENT') return; }
    for (const name of ['s.bound', 's.bound.tmp']) {
      const receipt = path.join(directory, name);
      try {
        const stat = fs.lstatSync(receipt);
        if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1) return;
        fs.unlinkSync(receipt);
      } catch (error) { if (error?.code !== 'ENOENT') return; }
    }
    fs.rmdirSync(directory);
  } catch {}
}

function executableFromPinnedCwd(command, identity) {
  if (!path.isAbsolute(command)) return command;
  for (const root of [identity.cwd, identity.requestedCwd]) {
    const relative = path.relative(root, command);
    if (relative === '') return '.';
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return `.${path.sep}${relative}`;
    }
  }
  return command;
}

function handoffEnvironment(env) {
  const safe = { ...env };
  // The client is a native executable. Dynamic-loader hooks would execute
  // before its peer authentication and fchdir, so they cannot be inherited
  // across this boundary. PWD is published only by the client after binding.
  for (const key of Object.keys(safe)) {
    if (key === 'PWD' || key.startsWith('LD_') || key.startsWith('DYLD_')) delete safe[key];
  }
  return safe;
}

// The broker inherits the already-validated directory as fd 3. The tmux pane
// sees only a trusted helper and a private socket path; it never resolves the
// user's pathname. No directory fd is sent until the parent authorizes the
// immutable pane PID returned by tmux new-session -P.
export function prepareTmuxCwdHandoff({ cwd, expectedIdentity, shell, command, env }, {
  binary,
  spawnBroker = spawn,
  tempRoot = '/tmp'
} = {}) {
  assertPinnedSessionLaunchAllowed({ env });
  if (typeof shell !== 'string' || !shell || typeof command !== 'string') {
    throw new CliError('BAD_ARGS', 'Trusted tmux launch requires shell and command');
  }
  binary ||= trustedCwdHandoffBinary();
  const captured = captureTrustedDirectoryFd(cwd, expectedIdentity);
  const nonce = randomBytes(32).toString('hex');
  let directory;
  let broker;
  let failed = false;
  try {
    directory = fs.mkdtempSync(path.join(tempRoot, 'hccfd-'));
    fs.chmodSync(directory, 0o700);
    const socket = path.join(directory, 's');
    const receipt = `${socket}.bound`;
    if (Buffer.byteLength(socket) >= 100) {
      throw new CliError('PINNED_CWD_UNAVAILABLE', 'Private helper socket path is too long');
    }
    const directoryStat = fs.lstatSync(directory);
    const brokerArgs = [
      'broker', '--socket', socket, '--dir-fd', '3',
      '--dev', captured.identity.dev, '--ino', captured.identity.ino,
      '--nonce', nonce
    ];
    broker = spawnBroker(binary, brokerArgs, {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe', captured.fd]
    });
    // spawn() can return a ChildProcess without a PID and emit ENOENT on the
    // next tick. Install both listeners before validating the returned child
    // so a failed helper launch cannot crash the Web runtime afterward.
    broker?.on?.('error', () => { failed = true; });
    broker?.stdin?.on?.('error', () => { failed = true; });
    if (!broker?.pid || !broker.stdin || !broker.stdout) {
      throw new CliError('PINNED_CWD_UNAVAILABLE', 'Trusted tmux directory broker did not start');
    }
    // The child now owns its independent copy; the parent no longer needs to
    // retain A's fd. The broker's native timeout bounds any ambiguous launch.
    captured.release();
    let bound = false;
    let released = false;
    let authorized = false;
    let output = '';
    const timer = setTimeout(() => {
      failed = true;
      killStartedBroker(broker);
    }, BROKER_TIMEOUT_MS);
    timer.unref?.();
    broker.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.length > 1024) { failed = true; killStartedBroker(broker); return; }
      for (;;) {
        const end = output.indexOf('\n');
        if (end < 0) break;
        const line = output.slice(0, end);
        output = output.slice(end + 1);
        if (line === 'READY') continue;
        if (line === 'BOUND' && authorized) { bound = true; continue; }
        failed = true;
        killStartedBroker(broker);
        break;
      }
    });
    broker.on('close', () => {
      if (!bound) failed = true;
      clearTimeout(timer);
      removeOwnedSocketDirectory(directory, directoryStat);
    });
    return {
      cwd: '/',
      command: binary,
      args: ['client', '--socket', socket,
        '--dev', captured.identity.dev, '--ino', captured.identity.ino,
        '--nonce', nonce, '--', executableFromPinnedCwd(shell, captured.identity), '-c', command],
      env: handoffEnvironment(env),
      identity: captured.identity,
      authorize(panePid) {
        if (authorized || failed || !Number.isSafeInteger(panePid) || panePid <= 0) {
          throw new CliError('PINNED_CWD_UNAVAILABLE', 'Cannot authorize trusted tmux pane');
        }
        authorized = true;
        writeBrokerAuthorizationSync(broker, `ALLOW ${panePid} ${nonce}\n`);
      },
      waitBoundSync(timeoutMs = BIND_TIMEOUT_MS) {
        if (!authorized || failed || released) {
          throw new CliError('PINNED_CWD_UNAVAILABLE', 'Trusted tmux pane is not authorized for directory handoff');
        }
        const deadline = Date.now() + timeoutMs;
        while (Date.now() <= deadline) {
          try {
            const parent = fs.lstatSync(directory);
            if (!parent.isDirectory() || parent.isSymbolicLink() ||
                parent.dev !== directoryStat.dev || parent.ino !== directoryStat.ino ||
                parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) {
              throw new CliError('PINNED_CWD_UNAVAILABLE', 'Private directory handoff parent changed');
            }
            const before = fs.lstatSync(receipt);
            if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
                before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 ||
                before.size !== 65) {
              throw new CliError('PINNED_CWD_UNAVAILABLE', 'Private directory handoff receipt is unsafe');
            }
            const fd = fs.openSync(receipt, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC);
            let data;
            try {
              const opened = fs.fstatSync(fd);
              if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== 65) {
                throw new CliError('PINNED_CWD_UNAVAILABLE', 'Private directory handoff receipt changed');
              }
              data = fs.readFileSync(fd, 'ascii');
            } finally { fs.closeSync(fd); }
            if (data !== `${nonce}\n`) {
              throw new CliError('PINNED_CWD_UNAVAILABLE', 'Private directory handoff receipt does not match');
            }
            fs.unlinkSync(receipt);
            bound = true;
            return true;
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
          Atomics.wait(bindSleep, 0, 0, 20);
        }
        throw new CliError('PINNED_CWD_UNAVAILABLE', 'Trusted tmux pane did not confirm directory binding');
      },
      acknowledged() { return bound; },
      failed() { return failed; },
      release() {
        if (released) return;
        released = true;
        clearTimeout(timer);
        if (!bound) killStartedBroker(broker);
        if (broker.exitCode !== null || broker.signalCode !== null) {
          removeOwnedSocketDirectory(directory, directoryStat);
        }
      }
    };
  } catch (error) {
    captured.release();
    killStartedBroker(broker);
    if (directory) {
      try { fs.rmdirSync(directory); } catch {}
    }
    throw error;
  }
}
