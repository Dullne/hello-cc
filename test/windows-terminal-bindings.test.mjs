import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../lib/db/schema.mjs';
import { createPeerBindingStore } from '../lib/db/stores/peers.mjs';
import { comparePeerBindings } from '../lib/core/peers/bindings.mjs';

test('provider hooks add session evidence without replacing a managed Windows terminal binding', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initSchema(db);
    db.prepare(`INSERT INTO peers(id,kind,role,worktree,status,created_at,last_seen_at)
      VALUES('managed','codex','peer','project','running',1,1)`).run();
    const store = createPeerBindingStore({ now: () => 10 });
    store.upsertPeerBinding(db, { peer: 'managed', provider: 'codex', transport: 'windows-terminal',
      runtime_session_id: 'terminal-generation', command: 'codex' });
    store.upsertPeerBinding(db, { peer: 'managed', provider: 'codex', transport: 'hook',
      runtime_session_id: 'provider-session', provider_session_id: 'provider-session', resume_mode: 'session' });
    const binding = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get('managed');
    assert.equal(binding.transport, 'windows-terminal');
    assert.equal(binding.runtime_session_id, 'terminal-generation');
    assert.equal(binding.command, 'codex');
    assert.equal(binding.provider_session_id, 'provider-session');
    assert.equal(binding.resume_mode, 'session');
    const candidates = [{ peer: 'newer-hook', transport: 'hook', updated_at: 100 }, binding];
    assert.equal(candidates.sort(comparePeerBindings)[0].peer, 'managed');
  } finally { db.close(); }
});
