import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { CliError } from '../shared/errors.mjs';
import { inspectProcessIdentity, compareProcessIdentity } from '../process/identity.mjs';
import { captureSelectedCwdSnapshot, assertSelectedCwdSnapshot } from '../process/selected-cwd-identity.mjs';

const execute = promisify(execFile);
const auditedVersions = new Set(['codex-cli 0.164.0-alpha.11.1']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = value => createHash('sha256').update(value).digest('hex');
const invalid = () => new CliError('CODEX_APP_QUEUE_IDENTITY_CHANGED', 'Original Desktop process, executable or shared queue ownership cannot be verified');
function fileIdentity(file) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid() && s.uid !== 0 || (s.mode & 0o022)) throw invalid();
  return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
}
function sameFile(file, saved, mutable = false) {
  const current = fileIdentity(file);
  if (current.dev !== saved.dev || current.ino !== saved.ino || !mutable &&
      (current.size !== saved.size || current.mtimeMs !== saved.mtimeMs)) throw invalid();
}
function runSync(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) throw invalid();
  return result.stdout.trim();
}

// Discover only this process's ancestors. A newly launched project MCP can
// renew an opted-in delivery after an App restart without selecting a thread
// from a shared session_id or scanning other applications and sockets.
export function discoverCodexAppRuntime({ pid = process.pid, sync = runSync,
  realpath = fs.realpathSync, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new CliError('CODEX_APP_QUEUE_UNSUPPORTED', 'Automatic App delivery is currently verified only on macOS');
  const seen = new Set();
  for (let depth = 0; depth < 24 && Number.isSafeInteger(pid) && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid);
    const match = sync('/bin/ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'comm=']).match(/^\s*(\d+)\s+(.+)$/);
    if (!match) throw invalid();
    const parent = Number(match[1]), executable = match[2];
    if (path.basename(executable) === 'codex') {
      const appExecutable = sync('/bin/ps', ['-p', String(parent), '-o', 'comm=']);
      if (/\/(?:Codex|ChatGPT)\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)$/.test(appExecutable)) {
        const files = sync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-F', 'n']);
        const queues = [...new Set(files.split('\n').filter(line => line.startsWith('n/') &&
          path.basename(line.slice(1)) === 'queue_1.sqlite').map(line => realpath(line.slice(1))))];
        if (queues.length !== 1) throw invalid();
        return { cli: realpath(executable), appServerPid: pid, sqliteHome: path.dirname(queues[0]),
          appExecutable: realpath(appExecutable) };
      }
    }
    pid = parent;
  }
  throw invalid();
}

// Uses the audited official queue CLI; never writes Codex SQLite or sends
// thread/start, thread/resume, turn/start or a private socket request. Queued
// means only queued. The original App and explicit HCC ACK prove consumption.
export async function createCodexAppQueueTransport({ root, threadId, cli, sqliteHome, appServerPid,
  inspect = inspectProcessIdentity, run = execute, sync = runSync, platform = process.platform,
  env = process.env } = {}) {
  if (platform !== 'darwin') throw new CliError('CODEX_APP_QUEUE_UNSUPPORTED', 'Original-App queue delivery is currently verified only on macOS');
  if (!uuid.test(threadId || '') || !path.isAbsolute(cli || '') || !path.isAbsolute(sqliteHome || '') ||
      !Number.isSafeInteger(appServerPid) || appServerPid < 1) throw new CliError('BAD_ARGS', 'Supply the current thread UUID, original App executable, sqlite home and server PID');
  const selected = captureSelectedCwdSnapshot(root), home = captureSelectedCwdSnapshot(sqliteHome);
  const executable = fs.realpathSync(cli), queueFile = path.join(home.canonical, 'queue_1.sqlite');
  const executableIdentity = fileIdentity(executable), queueIdentity = fileIdentity(queueFile);
  if (fs.lstatSync(queueFile).uid !== process.getuid()) throw invalid();
  const server = inspect(appServerPid);
  if (server.state !== 'live' || !server.identity) throw invalid();
  const info = sync('/bin/ps', ['-p', String(appServerPid), '-o', 'ppid=', '-o', 'comm=']);
  const match = info.match(/^\s*(\d+)\s+(.+)$/);
  if (!match || fs.realpathSync(match[2]) !== executable) throw invalid();
  const appPid = Number(match[1]), app = inspect(appPid);
  const appCommand = sync('/bin/ps', ['-p', String(appPid), '-o', 'comm=']);
  if (app.state !== 'live' || !app.identity || !/\/(?:Codex|ChatGPT)\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)$/.test(appCommand)) throw invalid();
  const version = (await run(executable, ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, env })).stdout.trim();
  if (!auditedVersions.has(version)) throw new CliError('CODEX_APP_QUEUE_VERSION_UNVERIFIED', 'Re-audit this Desktop CLI version before enabling automatic delivery');
  const executableSha256 = hash(fs.readFileSync(executable));
  function assertValid() {
    assertSelectedCwdSnapshot(selected); assertSelectedCwdSnapshot(home);
    if (fs.realpathSync(cli) !== executable) throw invalid();
    sameFile(executable, executableIdentity); sameFile(queueFile, queueIdentity, true);
    const currentServer = inspect(appServerPid), currentApp = inspect(appPid);
    if (currentServer.state !== 'live' || currentApp.state !== 'live' ||
        compareProcessIdentity(server.identity, currentServer.identity) !== 'live' ||
        compareProcessIdentity(app.identity, currentApp.identity) !== 'live') throw invalid();
    // txt ownership also rejects an updated on-disk binary with an old App
    // process still executing the previous inode.
    sync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(appServerPid), '-d', 'txt', '--', executable]);
    sync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(appServerPid), '--', queueFile]);
  }
  assertValid();
  return {
    assertValid,
    info: { version, appPid, appServerPid, executableSha256, threadId,
      originalAppIdentity: app.identity, originalServerIdentity: server.identity,
      queueFileIdentity: { dev: queueIdentity.dev, ino: queueIdentity.ino } },
    async enqueue({ text }) {
      if (typeof text !== 'string' || !text || Buffer.byteLength(text) > 16384) throw new CliError('BAD_ARGS', 'Queue notification must be bounded text');
      assertValid();
      const startedAt = new Date().toISOString();
      let response;
      try {
        response = await run(executable, ['-c', 'sqlite_home=' + JSON.stringify(home.canonical),
          'queue', '--thread', threadId, '--message', text, '--cd', selected.canonical],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, env });
      } catch { throw new CliError('CODEX_APP_QUEUE_UNCERTAIN', 'Official queue command failed or timed out; submission will not be retried automatically'); }
      const queued = response.stdout.match(/^Queued message ([0-9a-f-]+) for thread ([0-9a-f-]+)\.$/m);
      if (!queued || !uuid.test(queued[1]) || queued[2] !== threadId) throw new CliError('CODEX_APP_QUEUE_UNCERTAIN', 'Official queue receipt did not match this thread');
      assertValid();
      const db = new DatabaseSync(queueFile, { readOnly: true });
      let rowPresent;
      try {
        const row = db.prepare('SELECT payload_json FROM queued_items WHERE id=? AND thread_id=?').get(queued[1], threadId);
        rowPresent = Boolean(row);
        if (row) {
          const input = JSON.parse(row.payload_json).UserInput?.content;
          if (!Array.isArray(input) || input.length !== 1 || input[0].type !== 'text' || hash(input[0].text) !== hash(text)) throw invalid();
        }
      } finally { db.close(); }
      sameFile(queueFile, queueIdentity, true);
      return { queued: true, queueId: queued[1], threadId, startedAt, finishedAt: new Date().toISOString(),
        cliExited: true, version, appPid, appServerPid, executableSha256,
        originalAppIdentityUnchanged: true, sharedQueueRowVerified: rowPresent,
        payloadSha256: hash(text), delivered: false, acknowledged: false };
    }
  };
}
