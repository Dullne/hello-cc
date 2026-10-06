import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canRegisterProcessOnly, scanClaudeSessions, scanCodexSessions, scanProcesses,
  verifiedLiveProcessForRoot } from '../lib/discover.mjs';
import { createUpCommand } from '../lib/cli/commands/up.mjs';
import { createTmuxCommands } from '../lib/cli/commands/tmux.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-discover-root-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const selected = path.join(base, 'selected');
  const moved = path.join(base, 'moved');
  const procRoot = path.join(base, 'proc');
  const proc = path.join(procRoot, '123');
  fs.mkdirSync(selected);
  const originalRootIdentity = captureSelectedCwdSnapshot(selected);
  fs.mkdirSync(proc, { recursive: true });
  fs.renameSync(selected, moved);
  fs.mkdirSync(selected);
  const child = path.join(selected, 'child');
  fs.mkdirSync(child);
  const cmdline = 'node\0/usr/bin/codex\0resume\0old-thread\0';
  fs.writeFileSync(path.join(proc, 'cmdline'), cmdline);
  fs.writeFileSync(path.join(proc, 'environ'), 'HCC_PEER=old-history-peer\0');
  fs.symlinkSync(moved, path.join(proc, 'cwd'), 'dir');
  const identity = { pid: 123, startToken: 'boot:123',
    commandHash: createHash('sha256').update(cmdline.split('\0').filter(Boolean).join(' ')).digest('hex') };
  let observed = identity;
  const observeProcess = () => ({ state: 'live', identity: observed });
  const options = { procRoot, platform: 'linux', observeProcess };
  const ctx = { root: selected, dbPath: path.join(base, 'mesh.db'),
    initialRootIdentity: captureSelectedCwdSnapshot(selected) };
  return { selected, moved, child, proc, options, ctx, originalRootIdentity,
    setCwd(value) { fs.unlinkSync(path.join(proc, 'cwd')); fs.symlinkSync(value, path.join(proc, 'cwd'), 'dir'); },
    setIdentity(value) { observed = value; },
    scan() { return scanProcesses(options); },
    verify(row) { return verifiedLiveProcessForRoot(row, ctx, options); } };
}

test('session-file discovery never assigns unbound Claude or Codex history to a PID', () => {
  assert.deepEqual(scanClaudeSessions(), []);
  assert.deepEqual(scanCodexSessions(), []);
});

test('live process discovery rejects old A after rebinding and accepts B or its real child without claiming old ID', t => {
  const f = fixture(t);
  const [old] = f.scan();
  assert.equal(old.kind, 'codex');
  assert.equal(old.sessionId, '');
  assert.equal(old.resumeId, null);
  assert.equal(old.source, 'process');
  assert.match(old.peerId, /^codex-process-/);
  assert.equal(f.verify(old), null);
  assert.equal(f.verify({ ...old, sessionId: 'old-thread' }), null);

  // A new process at the same pathname must not inherit an old JSONL session ID.
  f.setCwd(f.selected);
  const [replacement] = f.scan();
  assert.equal(replacement.sessionId, '');
  assert.equal(f.verify(replacement).cwd, fs.realpathSync.native(f.selected));
  f.setCwd(f.child);
  const [nested] = f.scan();
  assert.equal(f.verify(nested).cwd, fs.realpathSync.native(f.child));
  assert.throws(() => verifiedLiveProcessForRoot(nested,
    { ...f.ctx, rootIdentity: f.originalRootIdentity }, f.options), { code: 'PROJECT_PATH_CHANGED' });

  // A reused PID, absent proc cwd, and a changed path after discovery all fail closed.
  f.setIdentity({ ...nested.processIdentity, startToken: 'boot:reused' });
  assert.equal(f.verify(nested), null);
  f.setIdentity(nested.processIdentity);
  f.setCwd(f.moved);
  assert.equal(f.verify(nested), null);
  fs.unlinkSync(path.join(f.proc, 'cwd'));
  assert.equal(f.verify(nested), null);
});

test('up and scan register only currently verified process-only records', async t => {
  const f = fixture(t);
  const peers = [], bindings = [];
  const savedBindings = new Map();
  const db = { exec() {}, close() {}, prepare(sql) {
    return { get(peer) {
      if (sql.includes('FROM peer_bindings')) return savedBindings.get(peer) || null;
      return null;
    } };
  } };
  const loadDiscover = async () => ({
    scanClaudeSessions() { throw new Error('historical Claude scan must not run'); },
    scanCodexSessions() { throw new Error('historical Codex scan must not run'); },
    scanProcesses: () => f.scan(),
    verifiedLiveProcessForRoot: (row, ctx) => verifiedLiveProcessForRoot(row, ctx, f.options),
    canRegisterProcessOnly
  });
  const up = createUpCommand({
    connect: () => db, helpUp() {}, PRODUCT_NAME: 'hello-cc', loadDiscover,
    loadSetup: async () => ({ verifyClaudeHooks: () => true, verifyCodexHooks: () => true }),
    writeGuidance: () => null,
    upsertPeer(_db, row) { peers.push(row); },
    upsertCanonicalPeerBinding(_db, row) { bindings.push(row); savedBindings.set(row.peer, row); }
  });
  const scan = createTmuxCommands({
    connect: () => db, loadDiscover,
    upsertPeer(_db, row) { peers.push(row); },
    upsertCanonicalPeerBinding(_db, row) { bindings.push(row); savedBindings.set(row.peer, row); },
    helpTmux() {}
  });
  assert.deepEqual((await up.prepareLocalBus(f.ctx, { 'no-guidance': true })).detected, []);
  assert.equal(peers.length, 0);
  await scan.cmdScan(f.ctx, ['--register']);
  assert.equal(peers.length, 0);

  f.setCwd(f.child);
  const detected = (await up.prepareLocalBus(f.ctx, { 'no-guidance': true })).detected;
  assert.equal(detected.length, 1);
  assert.equal(peers[0].worktree, fs.realpathSync.native(f.child));
  assert.equal(bindings[0].provider_session_id, null);
  await scan.cmdScan(f.ctx, ['--register']);
  assert.equal(peers.length, 2);
  assert.equal(bindings[1].provider_session_id, null);

  savedBindings.set(detected[0].peerId, { ...bindings[1], provider_session_id: 'old-thread' });
  assert.deepEqual((await up.prepareLocalBus(f.ctx, { 'no-guidance': true })).detected, []);
  await scan.cmdScan(f.ctx, ['--register']);
  assert.equal(peers.length, 2);
});
