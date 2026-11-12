import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConnectionHelpers } from '../lib/db/connection.mjs';
import { ensurePrivateProjectStateDir } from '../lib/runtime/private-state.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';
import { inspectProcessIdentity } from '../lib/process/identity.mjs';
import { prepareTerminalCreate } from '../lib/terminal/store.mjs';

test('Windows terminal creation refuses a live peer even when its stored status says exited or detached',
  { skip: process.platform !== 'win32' }, t => {
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
