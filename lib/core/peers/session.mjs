import { sanitizePeerPart, shortHash } from './format.mjs';
import { tx } from '../../db/schema.mjs';

function defaultNow() {
  return Math.floor(Date.now() / 1000);
}

function noopEvent() {}

// sess-04: derive the peer id from a sha1 hash of the FULL provider session
// id/name, not the first 8 raw chars — name-based ids that share a prefix
// (e.g. codex `feature-login` vs `feature-logout`) used to collide into the
// same peer id. The shim script derives the identical value (see
// lib/integrations/shims/script.mjs peer_hash). NOTE: this changes existing
// peer ids for name-based resumes (pre-1.0 intentional identity change).
export function providerSessionPeerId(kind, providerId) {
  return `${kind}-${shortHash(String(providerId || ''))}`;
}

// The pre-sess-04 derivation: the sanitized first 8 raw characters. Used only
// to recognize records created under the old scheme so they can be migrated.
export function legacyProviderSessionPeerId(kind, providerId) {
  return `${kind}-${sanitizePeerPart(String(providerId || '').slice(0, 8))}`;
}

// Tables whose peer references are plain TEXT columns (no FK) — migrate them in
// place so tasks/messages/locks/handoffs keep their ownership across the id
// change. events are deliberately left as recorded (audit trail).
const PEER_REFERENCE_COLUMNS = [
  ['tasks', 'owner'],
  ['tasks', 'assignee'],
  ['tasks', 'created_by'],
  ['messages', 'sender'],
  ['messages', 'recipient'],
  ['message_reads', 'peer'],
  ['locks', 'owner'],
  ['handoffs', 'from_peer'],
  ['handoffs', 'to_peer']
];

// Rename every peer record created under the legacy first-8-chars scheme to the
// sess-04 hashed id so live sessions do not become orphans across the upgrade.
// Idempotent and cheap: rows already under the hashed id are skipped, and
// custom (non-derived) ids are never touched. The hashed id may already exist
// (registered under the new scheme first) — in that case the legacy row is
// dropped after its references move, keeping foreign keys satisfied at every
// step by inserting the target row before updating references.
export function migrateLegacyProviderPeerIds(db, { now = defaultNow, addEvent = noopEvent } = {}) {
  const rows = db.prepare(`
    SELECT b.peer, b.provider, b.provider_session_id, b.provider_session_name
    FROM peer_bindings b
  `).all();
  const migrations = [];
  for (const row of rows) {
    const sessionValue = row.provider_session_id || row.provider_session_name;
    if (!sessionValue || !row.provider) continue;
    const newId = providerSessionPeerId(row.provider, sessionValue);
    if (row.peer === newId) continue;
    if (row.peer !== legacyProviderSessionPeerId(row.provider, sessionValue)) continue;
    migrations.push({ oldId: row.peer, newId, provider: row.provider, sessionValue });
  }
  if (!migrations.length) return { migrated: 0 };

  const t = now();
  tx(db, () => {
    for (const m of migrations) {
      // 1. Copy the legacy row to its hashed id (no-op when it already exists).
      db.prepare(`
        INSERT INTO peers(id, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at)
        SELECT ?, kind, role, worktree, branch, pid, status, capabilities, created_at, last_seen_at
        FROM peers WHERE id = ?
        ON CONFLICT(id) DO NOTHING
      `).run(m.newId, m.oldId);
      // 2. Move the binding (its runtime_session_id may equal the peer id).
      db.prepare(`
        UPDATE peer_bindings
        SET peer = ?,
            runtime_session_id = CASE WHEN runtime_session_id = ? THEN ? ELSE runtime_session_id END,
            updated_at = ?
        WHERE peer = ?
      `).run(m.newId, m.oldId, m.newId, t, m.oldId);
      // 3. Re-point plain-text references (peers may still be oldId here — fine,
      //    these columns carry no FK).
      for (const [table, column] of PEER_REFERENCE_COLUMNS) {
        db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(m.newId, m.oldId);
      }
      // 4. Drop the legacy row (its binding was moved in step 2, so the FK
      //    cascade has nothing left to remove).
      db.prepare('DELETE FROM peers WHERE id = ?').run(m.oldId);
      addEvent(db, 'peer.id.migrated', 'system', null, {
        old_peer: m.oldId,
        new_peer: m.newId,
        provider: m.provider,
        provider_session: m.sessionValue,
        source: 'sess-04'
      });
    }
  });
  return { migrated: migrations.length };
}

export function providerSessionParts(value) {
  if (!value) return { provider_session_id: null, provider_session_name: null };
  const text = String(value);
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
  return uuidLike
    ? { provider_session_id: text, provider_session_name: null }
    : { provider_session_id: null, provider_session_name: text };
}
