import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConnectionHelpers } from '../lib/db/connection.mjs';
import { ensurePrivateProjectStateDir } from '../lib/runtime/private-state.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';
import { inspectProcessIdentity } from '../lib/process/identity.mjs';
import { prepareTerminalCreate, publishTerminalCreated, validateTerminalProject } from '../lib/terminal/store.mjs';
import { createTerminalHost } from '../lib/terminal/host.mjs';
import { createWindowsTerminal } from '../lib/cli/windows-terminal.mjs';

function storeFixture(t) {
  const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-terminal-owner-'));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = path.join(base, 'profile'), root = path.join(base, 'project');
  fs.mkdirSync(home); fs.mkdirSync(root);
  process.env.HOME = process.env.USERPROFILE = home;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const stateDir = ensurePrivateProjectStateDir(root, { create: true });
  const rootIdentity = captureSelectedCwdSnapshot(root), dbPath = path.join(stateDir, 'mesh.db');
  const project = { root, stateDir, rootIdentity, dbPath };
  const { connect } = createConnectionHelpers({ now: () => 1, dedupePeerBindings() {}, redactedLogText: String });
  const db = connect({ root, dbPath, initialRootIdentity: rootIdentity }, { migrateRegistered: false });
  return { db, project, root, rootIdentity };
}

test('Windows terminal creation refuses a live peer even when its stored status says exited or detached',
  { skip: process.platform !== 'win32' }, t => {
    const { db, project, root } = storeFixture(t);
    try {
      const identity = inspectProcessIdentity(process.pid).identity;
      db.prepare(`INSERT INTO peers(id,kind,role,worktree,pid,pid_start_token,pid_command_hash,status,created_at,last_seen_at)
        VALUES('owned','shell','peer',?,?,?,?,'exited',1,1)`).run(root, identity.pid, identity.startToken, identity.commandHash);
      for (const status of ['exited', 'detached', 'running']) {
        db.prepare('UPDATE peers SET status = ? WHERE id = ?').run(status, 'owned');
        assert.throws(() => prepareTerminalCreate({ peerId: 'owned', project }), { code: 'PEER_RUNTIME_CONFLICT' });
        assert.equal(db.prepare('SELECT pid FROM peers WHERE id = ?').get('owned').pid, process.pid);
      }
      db.prepare("UPDATE peers SET status = 'exited', pid = NULL WHERE id = 'owned'").run();
      const release = prepareTerminalCreate({ peerId: 'owned', project });
      assert.throws(() => prepareTerminalCreate({ peerId: 'owned', project }), { code: 'PEER_RUNTIME_CONFLICT' });
      release();
      prepareTerminalCreate({ peerId: 'owned', project })();
    } finally { db.close(); }
  });

test('Windows terminal host refuses structured peers and provider aliases before spawning',
  { skip: process.platform !== 'win32' }, async t => {
    const { db, project, root, rootIdentity } = storeFixture(t);
    try {
      db.prepare(`INSERT INTO peers(id,kind,role,worktree,status,created_at,last_seen_at)
        VALUES('owned','codex','peer',?,'detached',1,1)`).run(root);
      db.prepare(`INSERT INTO peer_bindings(peer,provider,provider_session_id,provider_session_name,transport,created_at,updated_at)
        VALUES('owned','codex','owned-session','owned-name','native',1,1)`).run();
      db.prepare(`INSERT INTO peers(id,kind,role,worktree,status,created_at,last_seen_at)
        VALUES('terminal-owner','codex','peer',?,'detached',1,1)`).run(root);
      db.prepare(`INSERT INTO peer_bindings(peer,provider,provider_session_id,transport,created_at,updated_at)
        VALUES('terminal-owner','codex','terminal-session','windows-terminal',1,1)`).run();
      let spawns = 0;
      const host = createTerminalHost({ validateProject: validateTerminalProject, prepareCreate: prepareTerminalCreate,
        spawnPty() { spawns++; throw new Error('Structured owner must be checked before spawning'); } });
      let attempt = 0;
      for (const transport of ['native', 'app-server']) {
        db.prepare('UPDATE peer_bindings SET transport=? WHERE peer=?').run(transport, 'owned');
        const before = { ...db.prepare('SELECT * FROM peer_bindings WHERE peer=?').get('owned') };
        for (const input of [
          { peerId: 'owned', binding: { provider: 'shell' } },
          { peerId: 'alias-derived', binding: { provider_session_id: 'owned-session' } },
          { peerId: 'alias-id', binding: { provider: 'codex', provider_session_id: 'owned-session' } },
          { peerId: 'alias-name', binding: { provider: 'codex', provider_session_name: 'owned-name' } },
          { peerId: 'alias-mixed', binding: { provider: 'codex', provider_session_id: 'terminal-session', provider_session_name: 'owned-name' } }
        ]) {
          await assert.rejects(host.create({ id: `attempt-${++attempt}`, project, cwd: root, cwdIdentity: rootIdentity,
            kind: 'codex', command: { file: process.execPath, args: [] }, env: {}, ...input }),
          { code: 'PEER_RUNTIME_CONFLICT' });
          assert.equal(spawns, 0);
          assert.deepEqual({ ...db.prepare('SELECT * FROM peer_bindings WHERE peer=?').get('owned') }, before);
          assert.equal(db.prepare('SELECT COUNT(*) n FROM peers').get().n, 2);
        }
      }
      // The same session label from another provider is a separate identity.
      prepareTerminalCreate({ peerId: 'alias-id', project,
        binding: { provider: 'claude', provider_session_id: 'owned-session' } })();
      db.prepare("UPDATE peer_bindings SET transport='windows-terminal' WHERE peer='owned'").run();
      prepareTerminalCreate({ peerId: 'alias-id', project,
        binding: { provider: 'codex', provider_session_id: 'owned-session' } })();
    } finally { db.close(); }
  });

test('Windows terminal publication preserves a structured alias acquired after preparation',
  { skip: process.platform !== 'win32' }, t => {
    const { db, project, root, rootIdentity } = storeFixture(t);
    try {
      for (const transport of ['native', 'app-server']) {
        const binding = { ...(transport === 'app-server' ? { provider: 'codex' } : {}),
          provider_session_id: 'concurrent-session', resume_mode: 'resume' };
        const release = prepareTerminalCreate({ peerId: 'alias', kind: 'codex', project, binding });
        try {
          db.prepare(`INSERT INTO peers(id,kind,role,worktree,status,created_at,last_seen_at)
            VALUES('concurrent-owner','codex','peer',?,'detached',1,1)`).run(root);
          db.prepare(`INSERT INTO peer_bindings(peer,provider,provider_session_id,transport,created_at,updated_at)
            VALUES('concurrent-owner','codex','concurrent-session',?,1,1)`).run(transport);
          const before = { ...db.prepare("SELECT * FROM peer_bindings WHERE peer='concurrent-owner'").get() };
          const identity = inspectProcessIdentity(process.pid).identity;
          assert.throws(() => publishTerminalCreated({ id: 'terminal-race', peerId: 'alias', project,
            cwd: root, cwdIdentity: rootIdentity, kind: 'codex', role: 'peer', binding,
            command: { file: process.execPath, args: [] }, pid: process.pid,
            creationTime: identity.startToken.slice('win32:v1:'.length), processIdentity: identity }),
          { code: 'PEER_RUNTIME_CONFLICT' });
          assert.deepEqual({ ...db.prepare("SELECT * FROM peer_bindings WHERE peer='concurrent-owner'").get() }, before);
          assert.equal(db.prepare("SELECT * FROM peers WHERE id='alias'").get(), undefined);
        } finally { release(); }
        db.prepare("DELETE FROM peers WHERE id='concurrent-owner'").run();
      }
    } finally { db.close(); }
  });

test('Windows terminal CLI refuses a structured owner before contacting or starting its host',
  { skip: process.platform !== 'win32' }, async t => {
    const { db, project, root, rootIdentity } = storeFixture(t);
    try {
      db.prepare(`INSERT INTO peers(id,kind,role,worktree,status,created_at,last_seen_at)
        VALUES('owned','codex','peer',?,'detached',1,1)`).run(root);
      db.prepare(`INSERT INTO peer_bindings(peer,provider,provider_session_id,transport,created_at,updated_at)
        VALUES('owned','codex','owned-session','native',1,1)`).run();
      let hosts = 0;
      const terminalHostFactory = async () => { hosts++; throw new Error('Must refuse before starting a terminal host'); };
      for (const input of [
        { peerId: 'owned', binding: { provider: 'shell' } },
        { peerId: 'alias-derived', binding: { provider_session_id: 'owned-session' } },
        { peerId: 'alias', binding: { provider: 'codex', provider_session_id: 'owned-session' } }
      ]) {
        await assert.rejects(createWindowsTerminal({ root, dbPath: project.dbPath, initialRootIdentity: rootIdentity },
          { kind: 'codex', cwd: root, cwdIdentity: rootIdentity, command: { file: process.execPath, args: [] }, env: {}, ...input },
          { terminalHostFactory, restartOnEnvChange: true }), { code: 'PEER_RUNTIME_CONFLICT' });
        assert.equal(hosts, 0);
      }
    } finally { db.close(); }
  });
