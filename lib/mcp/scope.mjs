import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CliError } from '../shared/errors.mjs';
import { inspectProcessIdentity } from '../process/identity.mjs';
import { assertSelectedCwdSnapshot, captureSelectedCwdSnapshot,
  sameSelectedCwdIdentity } from '../process/selected-cwd-identity.mjs';
import { nativeOwnerGeneration } from '../runtime/native/store.mjs';
import { createWindowsPrivateDirectory, inspectWindowsPrivateDirectory,
  publishWindowsPrivateManifest, readWindowsPrivateFile, removeWindowsPrivateDirectory,
  withWindowsPrivateScope } from '../platform/windows-private-state.mjs';

const PATH_KEY = 'HCC_MCP_BOOTSTRAP_PATH';
const TOKEN_KEY = 'HCC_MCP_BOOTSTRAP_TOKEN';
const fail = () => { throw new CliError('MCP_SCOPE_INVALID', 'The scoped MCP capability is missing, revoked, or no longer owns this peer'); };
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => fs.realpathSync(path.resolve(value));
function validIdentity(value) {
  return value && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.startToken === 'string' && value.startToken.length > 0 && value.startToken.length < 512 &&
    typeof value.commandHash === 'string' && /^[a-f0-9]{64}$/.test(value.commandHash);
}
function sameIdentity(a, b) {
  return a?.pid === b?.pid && a?.startToken === b?.startToken && a?.commandHash === b?.commandHash;
}
function validRootIdentity(value) {
  return typeof value?.requested === 'string' && path.isAbsolute(value.requested) &&
    typeof value.canonical === 'string' && path.isAbsolute(value.canonical) &&
    sameSelectedCwdIdentity(value, value);
}
function assertLaunchRoot(root, rootIdentity) {
  if (!validRootIdentity(rootIdentity)) fail();
  if (typeof rootIdentity.assertUnchanged === 'function') rootIdentity.assertUnchanged();
  else assertSelectedCwdSnapshot(rootIdentity);
  const selected = captureSelectedCwdSnapshot(root);
  if (!sameSelectedCwdIdentity(rootIdentity, selected)) {
    throw new CliError('PROJECT_PATH_CHANGED', 'Selected project directory changed');
  }
  return { requested: selected.canonical, canonical: selected.canonical,
    identity: { ...rootIdentity.identity } };
}
function assertCapabilityRoot(receipt, root) {
  if (!validRootIdentity(receipt) || receipt.requested !== root || receipt.canonical !== root) fail();
  try { assertSelectedCwdSnapshot(receipt); }
  catch { fail(); }
}

// Per executor only: callers pass this entry to its thread configuration. No
// user/global Codex configuration is read or written.
export function createScopedMcpConfig({ root, dbPath, peer, executorId, ownerIdentity, rootIdentity,
  binding = { transport: 'app-server', runtimeSessionId: peer },
  cliPath = fileURLToPath(new URL('../../bin/hcc.mjs', import.meta.url)) }) {
  if (typeof peer !== 'string' || !peer.trim() || peer.length > 256 || /[\r\n\0]/.test(peer) ||
      typeof executorId !== 'string' || !executorId || executorId.length > 256 || !validIdentity(ownerIdentity) ||
      (binding.transport === 'native' && (binding.runtimeTarget !== executorId || binding.runtimeSessionId !== peer ||
        !nativeOwnerGeneration(executorId)))) fail();
  const launchRoot = assertLaunchRoot(root, rootIdentity);
  const scope = { root: launchRoot.canonical, dbPath: canonical(dbPath), peer, executorId,
    rootIdentity: launchRoot,
    ownerIdentity: { ...ownerIdentity }, binding: { ...binding } };
  if (typeof rootIdentity.assertUnchanged === 'function') rootIdentity.assertUnchanged();
  assertCapabilityRoot(scope.rootIdentity, scope.root);
  const entrypoint = canonical(cliPath);
  let directory, directoryIdentity, bootstrapPath;
  const remove = () => process.platform === 'win32'
    ? removeWindowsPrivateDirectory(directory, directoryIdentity)
    : fs.rmSync(directory, { recursive: true, force: true });
  const token = randomBytes(32).toString('base64url');
  function publish() {
    if (process.platform === 'win32') {
      // Keep the new private directory pinned from creation through publication.
      // Reopening its path after releasing this scope could select a replacement.
      inspectWindowsPrivateDirectory(path.dirname(scope.dbPath));
      directory = path.join(path.dirname(scope.dbPath), `mcp-${randomBytes(16).toString('hex')}`);
      directoryIdentity = createWindowsPrivateDirectory(directory).identity;
    } else {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-mcp-'));
      fs.chmodSync(directory, 0o700);
    }
    bootstrapPath = path.join(directory, 'scope.json');
    try {
      assertCapabilityRoot(scope.rootIdentity, scope.root);
      const manifest = { version: 2, ...scope, tokenHash: digest(token) };
      if (process.platform === 'win32') publishWindowsPrivateManifest(bootstrapPath, manifest);
      else fs.writeFileSync(bootstrapPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    } catch (error) { remove(); throw error; }
  }
  if (process.platform === 'win32') withWindowsPrivateScope(publish);
  else publish();
  let disposed = false;
  return {
    config: { command: process.execPath,
      args: [entrypoint, '--root', scope.root, '--db', scope.dbPath, 'mcp', 'serve', '--peer', peer],
      env: { [PATH_KEY]: bootstrapPath, [TOKEN_KEY]: token } },
    dispose() { if (!disposed) { remove(); disposed = true; } }
  };
}

export function loadScopedMcpBootstrap(ctx, peer, env = process.env) {
  const bootstrapPath = env[PATH_KEY], token = env[TOKEN_KEY];
  if (typeof bootstrapPath !== 'string' || !path.isAbsolute(bootstrapPath) ||
      typeof token !== 'string' || token.length < 32 || token.length > 256) fail();
  function read() {
    let fd;
    try {
      let bytes;
      if (process.platform === 'win32') {
        bytes = readWindowsPrivateFile(bootstrapPath, { maxBytes: 16384 });
      } else {
        const parent = fs.lstatSync(path.dirname(bootstrapPath));
        if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) fail();
        fd = fs.openSync(bootstrapPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384 || (stat.mode & 0o077) ||
            (process.getuid && stat.uid !== process.getuid())) fail();
        bytes = fs.readFileSync(fd);
      }
      const value = JSON.parse(bytes.toString('utf8'));
      if (value.version !== 2 || typeof value.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.tokenHash) ||
          !timingSafeEqual(Buffer.from(value.tokenHash, 'hex'), Buffer.from(digest(token), 'hex'))) fail();
      assertCapabilityRoot(value.rootIdentity, value.root);
      if (
          value.root !== canonical(ctx.root) || value.dbPath !== canonical(ctx.dbPath) ||
          value.peer !== peer || !validIdentity(value.ownerIdentity) ||
          typeof value.executorId !== 'string' || !value.executorId || !value.binding ||
          typeof value.binding.transport !== 'string' ||
          (value.binding.transport === 'native' && (value.binding.runtimeTarget !== value.executorId || value.binding.runtimeSessionId !== peer ||
            !nativeOwnerGeneration(value.executorId)))) fail();
      return value;
    } catch { fail(); } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  const original = read(), originalHash = digest(JSON.stringify(original));
  function assertValid() {
    const value = read();
    if (digest(JSON.stringify(value)) !== originalHash) fail();
    const observation = inspectProcessIdentity(value.ownerIdentity.pid);
    if (observation.state !== 'live' || !sameIdentity(value.ownerIdentity, observation.identity)) fail();
  }
  function assertOwnership(db) {
    assertValid();
    const row = db.prepare('SELECT * FROM peers WHERE id = ?').get(peer);
    if (!row || ['exited', 'detached'].includes(row.status) || !sameIdentity(original.ownerIdentity,
      { pid: Number(row.pid), startToken: row.pid_start_token, commandHash: row.pid_command_hash })) fail();
    const binding = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(peer);
    if (!binding || binding.transport !== original.binding.transport ||
        (original.binding.runtimeSessionId !== undefined && binding.runtime_session_id !== original.binding.runtimeSessionId) ||
        (original.binding.runtimeTarget !== undefined && binding.runtime_target !== original.binding.runtimeTarget)) fail();
    if (original.binding.transport === 'app-server') {
      const receipt = db.prepare(`SELECT payload FROM events WHERE type = 'codex.executor.started'
        AND actor = ? ORDER BY id DESC LIMIT 1`).get(peer);
      let executor;
      try { executor = JSON.parse(receipt?.payload || '{}').executor_id; } catch { fail(); }
      if (executor !== original.executorId) fail();
    }
  }
  assertValid();
  const rootIdentity = Object.freeze({ requested: original.rootIdentity.requested,
    canonical: original.rootIdentity.canonical,
    identity: Object.freeze({ ...original.rootIdentity.identity }) });
  return { scope: Object.freeze({ root: original.root, dbPath: original.dbPath, peer,
    executorId: original.executorId, rootIdentity,
    nativeOwnerGeneration: original.binding.transport === 'native' ? nativeOwnerGeneration(original.executorId) : null }),
    assertValid, assertOwnership };
}
