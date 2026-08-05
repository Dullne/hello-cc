import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { deriveAutomation } from '../lib/core/coordination/automation.mjs';
import * as peerEvidence from '../lib/core/peers/evidence.mjs';
import { createTaskStore } from '../lib/core/coordination/tasks.mjs';
import { runOptimisticEvidenceMutation } from '../lib/core/coordination/optimistic-evidence.mjs';
import {
  captureLockAcquireSubject,
  observeLockOwnerEvidence,
  sameLockAcquireSubject
} from '../lib/core/coordination/lock-evidence.mjs';
import { scopedLockResource } from '../lib/core/coordination/locks.mjs';
import {
  prepareTmuxRestartBinding,
  rollbackTmuxRestartBinding
} from '../lib/core/peers/tmux-safety.mjs';

const { resolvePeerEvidence } = peerEvidence;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

test('provider restart may restore only a detached tmux binding with a CAS rollback token', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE peer_bindings (
      peer TEXT PRIMARY KEY,
      transport TEXT NOT NULL,
      runtime_target TEXT,
      updated_at INTEGER
    );
  `);
  try {
    db.prepare('INSERT INTO peer_bindings VALUES (?, ?, ?, ?)')
      .run('peer-a', 'tmux', null, 100);
    const prepared = prepareTmuxRestartBinding(db, {
      peer: 'peer-a',
      runtimeTarget: '%7',
      nowSec: 100
    });
    assert.deepEqual(prepared, {
      ok: true,
      restored: true,
      peer: 'peer-a',
      runtimeTarget: '%7',
      previousUpdatedAt: 100,
      preparedUpdatedAt: 101
    });
    assert.deepEqual({ ...db.prepare('SELECT runtime_target, updated_at FROM peer_bindings WHERE peer = ?')
      .get('peer-a') }, { runtime_target: '%7', updated_at: 101 });
    assert.equal(rollbackTmuxRestartBinding(db, prepared), true);
    assert.deepEqual({ ...db.prepare('SELECT runtime_target, updated_at FROM peer_bindings WHERE peer = ?')
      .get('peer-a') }, { runtime_target: null, updated_at: 100 });

    db.prepare('UPDATE peer_bindings SET runtime_target = ?, updated_at = ? WHERE peer = ?')
      .run('%8', 102, 'peer-a');
    assert.deepEqual(prepareTmuxRestartBinding(db, {
      peer: 'peer-a', runtimeTarget: '%7', nowSec: 103
    }), { ok: false, reason: 'tmux_binding_target_changed' });
    assert.equal(db.prepare('SELECT runtime_target FROM peer_bindings WHERE peer = ?')
      .get('peer-a').runtime_target, '%8');
  } finally {
    db.close();
  }
});

function identity(pid, startToken = `boot:${pid}`, commandHash = HASH_A) {
  return { pid, startToken, commandHash };
}

function processEvidence(pid, options = {}) {
  const storedIdentity = options.storedIdentity === undefined
    ? identity(pid)
    : options.storedIdentity;
  const currentIdentity = options.currentIdentity === undefined
    ? identity(pid)
    : options.currentIdentity;
  return {
    name: options.name || 'peer',
    storedIdentity,
    current: {
      state: options.state || 'live',
      identity: currentIdentity
    }
  };
}

function verifiedTmux(options = {}) {
  return {
    managed: true,
    session: options.session || { state: 'live', expected: 'hcc-root-peer', actual: 'hcc-root-peer' },
    pane: options.pane || { state: 'live', expected: '%7', actual: '%7' },
    root: options.root || { state: 'match', expected: '/repo', actual: '/repo' },
    process: options.process || processEvidence(700, { name: 'pane' })
  };
}

const fixtures = [
  {
    name: 'matching live process identity overrides stale explicit exited status',
    input: {
      peer: { status: 'exited' },
      processes: [processEvidence(101)]
    },
    expected: { state: 'live', reason: 'process_identity_match' }
  },
  {
    name: 'detached non-tmux peer with matching identity is live',
    input: {
      peer: { status: 'detached' },
      processes: [processEvidence(102)]
    },
    expected: { state: 'live', reason: 'process_identity_match' }
  },
  {
    name: 'tmux-managed detached peer with fully validated evidence is live',
    input: {
      peer: { status: 'detached' },
      tmux: verifiedTmux()
    },
    expected: { state: 'live', reason: 'tmux_identity_match' }
  },
  {
    name: 'non-tmux working peer with a reused PID fingerprint is dead',
    input: {
      peer: { status: 'working' },
      processes: [processEvidence(103, {
        currentIdentity: identity(103, 'boot:reused', HASH_B)
      })]
    },
    expected: { state: 'dead', reason: 'process_identity_mismatch' }
  },
  {
    name: 'legacy peer with a current process but no stored full identity is unknown',
    input: {
      peer: { status: 'working' },
      processes: [processEvidence(104, { storedIdentity: { pid: 104 } })]
    },
    expected: { state: 'unknown', reason: 'process_identity_incomplete' }
  },
  {
    name: 'legacy missing process without a stored full identity is dead',
    input: {
      peer: { status: 'working' },
      processes: [processEvidence(104, {
        storedIdentity: { pid: 104 },
        state: 'dead',
        currentIdentity: null
      })]
    },
    expected: { state: 'dead', reason: 'process_missing' }
  },
  {
    name: 'non-tmux peer with confirmed missing wrapper and child is dead',
    input: {
      peer: { status: 'detached' },
      processes: [
        processEvidence(105, { name: 'wrapper', state: 'dead', currentIdentity: null }),
        processEvidence(106, { name: 'child', state: 'dead', currentIdentity: null })
      ]
    },
    expected: { state: 'dead', reason: 'process_missing' }
  },
  {
    name: 'tmux-managed missing pane plus dead stored process is dead',
    input: {
      peer: { status: 'running' },
      tmux: verifiedTmux({
        pane: { state: 'dead', expected: '%7', actual: null },
        process: processEvidence(700, { name: 'pane', state: 'dead', currentIdentity: null })
      })
    },
    expected: { state: 'dead', reason: 'tmux_and_process_dead' }
  },
  {
    name: 'tmux-managed unknown pane is unknown',
    input: {
      peer: { status: 'running' },
      tmux: verifiedTmux({ pane: { state: 'unknown', expected: '%7', actual: null } })
    },
    expected: { state: 'unknown', reason: 'tmux_evidence_incomplete' }
  },
  {
    name: 'tmux-managed root mismatch is unknown',
    input: {
      peer: { status: 'running' },
      tmux: verifiedTmux({ root: { state: 'mismatch', expected: '/repo', actual: '/other' } })
    },
    expected: { state: 'unknown', reason: 'tmux_root_mismatch' }
  },
  {
    name: 'matching owner process stays live despite a foreign tmux target',
    input: {
      peer: { status: 'working' },
      processes: [processEvidence(701)],
      tmux: verifiedTmux({ root: { state: 'mismatch', expected: '/repo', actual: '/other' } })
    },
    expected: { state: 'live', reason: 'process_identity_match' }
  },
  {
    name: 'dead owner process is dead despite a separately live tmux target',
    input: {
      peer: { status: 'working' },
      processes: [processEvidence(701, { state: 'dead', currentIdentity: null })],
      tmux: verifiedTmux()
    },
    expected: { state: 'dead', reason: 'process_missing' }
  },
  {
    name: 'tmux-managed root mismatch stays unknown despite dead process evidence',
    input: {
      peer: { status: 'running' },
      tmux: verifiedTmux({
        pane: { state: 'dead', expected: '%7', actual: null },
        root: { state: 'mismatch', expected: '/repo', actual: '/other' },
        process: processEvidence(700, { name: 'pane', state: 'dead', currentIdentity: null })
      })
    },
    expected: { state: 'unknown', reason: 'tmux_root_mismatch' }
  },
  {
    name: 'tmux session identity mismatch stays unknown despite missing pane and dead process',
    input: {
      peer: { status: 'running' },
      tmux: verifiedTmux({
        session: { state: 'unknown', expected: 'hcc-root-peer:100', actual: 'hcc-root-peer:200' },
        pane: { state: 'dead', expected: '%7', actual: null },
        process: processEvidence(700, { name: 'pane', state: 'dead', currentIdentity: null })
      })
    },
    expected: { state: 'unknown', reason: 'tmux_evidence_incomplete' }
  },
  {
    name: 'verified live matching process wins over unknown auxiliary evidence',
    input: {
      peer: { status: 'working' },
      processes: [
        processEvidence(107),
        processEvidence(108, { name: 'wrapper', state: 'unknown', currentIdentity: null })
      ]
    },
    expected: { state: 'live', reason: 'process_identity_match' }
  }
];

for (const fixture of fixtures) {
  test(fixture.name, () => {
    assert.deepEqual(resolvePeerEvidence(fixture.input), fixture.expected);
  });
}

test('automation trusts retained expired lock evidence', () => {
  const automation = deriveAutomation({
    now: 2000,
    active_peer_ttl: 600,
    peers: [
      { id: 'worker', age_sec: 0 }
    ],
    tasks: [
      { id: 1, status: 'running', owner: 'worker', assignee: 'worker', title: 'Owned work', priority: 1, parent_id: null }
    ],
    locks: [
      {
        resource: 'src/shared.mjs',
        base_resource: 'src/shared.mjs',
        scope: '*',
        owner: 'live-owner',
        task_id: 2,
        expires_at: 1000,
        created_at: 500
      }
    ],
    messages: []
  }, 'worker', { resources: ['src/shared.mjs'] });

  assert.equal(automation.phase, 'coordinate_lock');
  assert.equal(automation.next_action.kind, 'msg.send');
  assert.equal(automation.next_action.lock_owner, 'live-owner');
  assert.equal(automation.actions.some((action) => action.kind === 'lock.acquire'), false);
});

test('shared activity policy gives evidence precedence over heartbeat age', () => {
  assert.equal(typeof peerEvidence.classifyPeerActivity, 'function');
  const classify = peerEvidence.classifyPeerActivity;
  assert.deepEqual(classify({ evidence_state: 'dead', age_sec: 1 }, { activePeerTtl: 60 }), { active: false, stale: true });
  assert.deepEqual(classify({ evidence_state: 'live', age_sec: 3600 }, { activePeerTtl: 60 }), { active: true, stale: false });
  assert.deepEqual(classify({ evidence_state: 'unknown', age_sec: 1 }, { activePeerTtl: 60 }), { active: true, stale: false });
  assert.deepEqual(classify({ evidence_state: 'unknown', age_sec: 3600 }, { activePeerTtl: 60 }), { active: false, stale: true });
  assert.deepEqual(classify({ evidence_state: 'unknown', age_sec: 3600 }, { activePeerTtl: 60, graceActive: true }), { active: true, stale: false });
});

test('reaper allows dead immediately and unknown only after 120 second grace', () => {
  const allows = peerEvidence.peerEvidenceAllowsReap;
  assert.equal(allows({ state: 'live' }, {
    nowSec: 1120, lastSeenAt: 1000, staleAfterSec: 120, graceUntil: 0
  }), false);
  assert.equal(allows({ state: 'dead' }, {
    nowSec: 1000, lastSeenAt: 1000, staleAfterSec: 120, graceUntil: 1200
  }), true);
  assert.equal(allows({ state: 'unknown' }, {
    nowSec: 1119, lastSeenAt: 1000, staleAfterSec: 120, graceUntil: 0
  }), false);
  assert.equal(allows({ state: 'unknown' }, {
    nowSec: 1120, lastSeenAt: 1000, staleAfterSec: 120, graceUntil: 1121
  }), false);
  assert.equal(allows({ state: 'unknown' }, {
    nowSec: 1120, lastSeenAt: 1000, staleAfterSec: 120, graceUntil: 1120
  }), true);
  assert.equal(allows({ state: 'unknown' }, {
    nowSec: 1120, lastSeenAt: Number.NaN, staleAfterSec: 120, graceUntil: 0
  }), false);
});

function taskStoreDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      assignee TEXT,
      owner TEXT,
      claimed_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE peers (
      id TEXT PRIMARY KEY,
      status TEXT,
      pid INTEGER,
      pid_start_token TEXT,
      pid_command_hash TEXT,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE peer_bindings (
      peer TEXT PRIMARY KEY,
      transport TEXT,
      runtime_target TEXT,
      updated_at INTEGER
    );
  `);
  return db;
}

test('takeover observes owner evidence outside the write transaction', () => {
  const db = taskStoreDb();
  try {
    db.prepare("INSERT INTO tasks VALUES (1, 'work', 'running', NULL, 'owner-a', NULL, 1)").run();
    db.prepare("INSERT INTO peers VALUES ('owner-a', 'working', NULL, NULL, NULL, 1)").run();
    const store = createTaskStore({ now: () => 1000 });
    let evidenceInsideTransaction = null;
    const task = store.takeOverTaskForPeer(db, 'taker', 1, {
      reason: 'confirmed dead',
      policy: 'stale',
      staleAfter: 60,
      ownerEvidenceFor: () => {
        evidenceInsideTransaction = db.isTransaction;
        return { state: 'dead', reason: 'process_missing' };
      }
    });
    assert.equal(evidenceInsideTransaction, false);
    assert.equal(task.owner, 'taker');
  } finally {
    db.close();
  }
});

test('aged tmux-unknown owner follows age policy instead of staying active forever', () => {
  const db = taskStoreDb();
  try {
    db.prepare("INSERT INTO tasks VALUES (1, 'work', 'running', NULL, 'owner-a', NULL, 1)").run();
    db.prepare("INSERT INTO peers VALUES ('owner-a', 'working', NULL, NULL, NULL, 1)").run();
    const store = createTaskStore({ now: () => 1000 });
    const task = store.takeOverTaskForPeer(db, 'taker', 1, {
      reason: 'aged unknown evidence',
      policy: 'stale',
      staleAfter: 60,
      ownerEvidenceFor: () => ({ state: 'unknown', reason: 'tmux_evidence_incomplete' })
    });
    assert.equal(task.owner, 'taker');
  } finally {
    db.close();
  }
});

test('unknown takeover protection expires when the persisted 120 second grace ends', () => {
  const db = taskStoreDb();
  let nowSec = 1000;
  try {
    db.prepare("INSERT INTO tasks VALUES (1, 'work', 'running', NULL, 'owner-a', NULL, 1)").run();
    db.prepare("INSERT INTO peers VALUES ('owner-a', 'working', 700, NULL, NULL, 1)").run();
    db.prepare("INSERT INTO meta(key, value) VALUES ('clock_grace_until', '1120')").run();
    const store = createTaskStore({ now: () => nowSec });
    const options = {
      reason: 'bounded unknown evidence',
      policy: 'stale',
      staleAfter: 60,
      ownerEvidenceFor: () => ({ state: 'unknown', reason: 'process_identity_incomplete' })
    };

    assert.throws(
      () => store.takeOverTaskForPeer(db, 'taker', 1, options),
      (error) => error?.code === 'TAKEOVER_POLICY'
    );
    nowSec = 1120;
    assert.equal(store.takeOverTaskForPeer(db, 'taker', 1, options).owner, 'taker');
  } finally {
    db.close();
  }
});

test('takeover aborts when the owner subject changes on every evidence attempt', () => {
  const db = taskStoreDb();
  try {
    db.prepare("INSERT INTO tasks VALUES (1, 'work', 'running', NULL, 'owner-a', NULL, 1)").run();
    db.prepare("INSERT INTO peers VALUES ('owner-a', 'working', NULL, NULL, NULL, 1)").run();
    db.prepare("INSERT INTO peers VALUES ('owner-b', 'working', NULL, NULL, NULL, 1)").run();
    const store = createTaskStore({ now: () => 1000 });
    assert.throws(() => store.takeOverTaskForPeer(db, 'taker', 1, {
      reason: 'must not apply stale evidence',
      policy: 'stale',
      staleAfter: 60,
      ownerEvidenceFor: (owner) => {
        const nextOwner = owner === 'owner-a' ? 'owner-b' : 'owner-a';
        db.prepare('UPDATE tasks SET owner = ?, updated_at = updated_at + 1 WHERE id = 1').run(nextOwner);
        return { state: 'dead', reason: 'process_missing' };
      }
    }), (error) => error?.code === 'SUBJECT_CHANGED');
    assert.notEqual(db.prepare('SELECT owner FROM tasks WHERE id = 1').get().owner, 'taker');
  } finally {
    db.close();
  }
});

test('optimistic evidence callbacks run outside transactions and reject changed subjects', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE subjects (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, value TEXT NOT NULL)');
    db.prepare("INSERT INTO subjects VALUES (1, 1, 'original')").run();
    let observedInTransaction = null;
    assert.throws(() => runOptimisticEvidenceMutation(db, {
      capture: (subjectDb) => subjectDb.prepare('SELECT * FROM subjects WHERE id = 1').get(),
      observe: (subject) => {
        observedInTransaction = db.isTransaction;
        db.prepare('UPDATE subjects SET version = version + 1 WHERE id = 1').run();
        return { version: subject.version };
      },
      same: (before, after) => JSON.stringify(before) === JSON.stringify(after),
      mutate: () => db.prepare("UPDATE subjects SET value = 'mutated' WHERE id = 1").run(),
      attempts: 2
    }), (error) => error?.code === 'SUBJECT_CHANGED');
    assert.equal(observedInTransaction, false);
    assert.equal(db.prepare('SELECT value FROM subjects WHERE id = 1').get().value, 'original');
  } finally {
    db.close();
  }
});

test('optimistic preparation runs only after exact subject re-read and inside the mutation transaction', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE values_table (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare("INSERT INTO values_table VALUES (1, 'initial')").run();
  let observations = 0;
  let preparations = 0;
  const result = runOptimisticEvidenceMutation(db, {
    capture: (subjectDb) => subjectDb.prepare('SELECT * FROM values_table WHERE id = 1').get(),
    observe: () => {
      observations += 1;
      if (observations === 1) db.prepare("UPDATE values_table SET value = 'changed'").run();
      return { state: 'unknown' };
    },
    same: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    beforeMutate: (subject, evidence) => {
      preparations += 1;
      assert.equal(db.isTransaction, true);
      assert.equal(subject.value, 'changed');
      assert.equal(evidence.state, 'unknown');
      return { graceUntil: 1120 };
    },
    mutate: (subject, _evidence, prepared) => ({ subject, prepared })
  });

  assert.equal(observations, 2);
  assert.equal(preparations, 1);
  assert.equal(result.subject.value, 'changed');
  assert.equal(result.prepared.graceUntil, 1120);
  db.close();
});

test('lock evidence captures conflicts and probes only expired conflicting owners', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT);
      CREATE TABLE locks (
        resource TEXT PRIMARY KEY, base_resource TEXT, scope TEXT, owner TEXT,
        task_id INTEGER, expires_at INTEGER, created_at INTEGER, ttl_sec INTEGER
      );
      CREATE TABLE peers (
        id TEXT PRIMARY KEY, status TEXT, pid INTEGER, pid_start_token TEXT,
        pid_command_hash TEXT, last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE peer_bindings (
        peer TEXT PRIMARY KEY, transport TEXT, runtime_target TEXT, updated_at INTEGER
      );
    `);
    db.prepare("INSERT INTO peers VALUES ('expired-owner', 'working', NULL, NULL, NULL, 1)").run();
    db.prepare("INSERT INTO peers VALUES ('fresh-owner', 'working', NULL, NULL, NULL, 1)").run();
    db.prepare("INSERT INTO peers VALUES ('unrelated-owner', 'working', NULL, NULL, NULL, 1)").run();
    const insert = db.prepare(`
      INSERT INTO locks(resource, base_resource, scope, owner, expires_at, created_at, ttl_sec)
      VALUES (?, ?, ?, ?, ?, 1, 60)
    `);
    insert.run('scoped-old', 'src/a.mjs', 'lines:1-5', 'expired-owner', 99);
    insert.run('scoped-fresh', 'src/a.mjs', 'lines:8-10', 'fresh-owner', 200);
    insert.run('whole-fresh', 'src/a.mjs', '*', 'fresh-owner', 200);
    insert.run('unrelated-old', 'src/b.mjs', '*', 'unrelated-owner', 1);

    const requested = scopedLockResource('src/a.mjs', 'lines:1-5');
    const subject = captureLockAcquireSubject(db, { taskId: null, requested, now: 100 });
    assert.deepEqual(subject.locks.map((lock) => lock.resource), ['scoped-old', 'whole-fresh']);
    let calls = 0;
    const evidence = observeLockOwnerEvidence(subject, (peer) => {
      calls += 1;
      return { state: 'live', reason: peer.id };
    });
    assert.equal(calls, 1);
    assert.deepEqual([...evidence.keys()], ['expired-owner']);
    db.prepare("UPDATE locks SET expires_at = 2 WHERE resource = 'unrelated-old'").run();
    assert.equal(sameLockAcquireSubject(subject,
      captureLockAcquireSubject(db, { taskId: null, requested, now: 100 })), true);
    db.prepare("UPDATE locks SET expires_at = 98 WHERE resource = 'scoped-old'").run();
    assert.equal(sameLockAcquireSubject(subject,
      captureLockAcquireSubject(db, { taskId: null, requested, now: 100 })), false);
  } finally {
    db.close();
  }
});

test('event GC preserves only the latest authority for each current tmux binding', async () => {
  const retention = await import('../lib/core/coordination/event-retention.mjs').catch(() => ({}));
  assert.equal(typeof retention.pruneOldEventsPreservingTmuxAuthority, 'function');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE peer_bindings (
        peer TEXT PRIMARY KEY, transport TEXT, runtime_target TEXT
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    db.prepare("INSERT INTO peer_bindings VALUES ('peer-a', 'tmux', '%7')").run();
    db.prepare("INSERT INTO peer_bindings VALUES ('peer-b', 'tmux', NULL)").run();
    const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?)');
    insert.run(1, 'tmux.session.attached', JSON.stringify({ target_peer: 'peer-a', pane: '%7', tmux_session_created: 'old' }), 1);
    insert.run(2, 'tmux.session.attached', JSON.stringify({ target_peer: 'peer-a', pane: '%7', tmux_session_created: 'current' }), 2);
    insert.run(3, 'tmux.session.attached', JSON.stringify({ target_peer: 'peer-a', pane: '%6', tmux_session_created: 'superseded-pane' }), 3);
    insert.run(4, 'message.sent', '{}', 4);
    insert.run(5, 'tmux.session.attached', JSON.stringify({ target_peer: 'peer-b', pane: '%8', tmux_session_created: 'detached' }), 5);

    assert.equal(retention.pruneOldEventsPreservingTmuxAuthority(db, 100, { dryRun: true }), 3);
    assert.deepEqual(db.prepare('SELECT id FROM events ORDER BY id').all().map((row) => row.id), [1, 2, 3, 4, 5]);
    assert.equal(retention.pruneOldEventsPreservingTmuxAuthority(db, 100), 3);
    assert.deepEqual(db.prepare('SELECT id FROM events ORDER BY id').all().map((row) => row.id), [2, 5]);
  } finally {
    db.close();
  }
});

test('destructive tmux validation rejects reuse and incomplete observations', async () => {
  const tmuxSafety = await import('../lib/core/peers/tmux-safety.mjs').catch(() => ({}));
  assert.equal(typeof tmuxSafety.validateTmuxDestructiveEvidence, 'function');
  const validate = tmuxSafety.validateTmuxDestructiveEvidence;
  const identity = identityForTmux(700);
  const stored = {
    session: 'hcc-root-peer',
    session_created: '100',
    session_id: '$1',
    root: '/repo',
    pane: '%7',
    process_identity: identity
  };
  const observed = {
    ...stored,
    clients: { state: 'known', count: 0 },
    process_identity: identity
  };

  assert.deepEqual(validate(stored, observed), { ok: true });
  assert.deepEqual(validate(stored, { ...observed, session_created: '200' }), { ok: false, reason: 'tmux_session_reused' });
  assert.deepEqual(validate(stored, { ...observed, root: null }), { ok: false, reason: 'tmux_root_unknown' });
  assert.deepEqual(validate(stored, { ...observed, clients: { state: 'unknown' } }), { ok: false, reason: 'tmux_clients_unknown' });
});

test('tmux GC planning and apply accept only an exact confirmed-dead pane', async () => {
  const tmuxSafety = await import('../lib/core/peers/tmux-safety.mjs').catch(() => ({}));
  assert.equal(typeof tmuxSafety.validateTmuxGcDeadProcessEvidence, 'function');
  const validate = tmuxSafety.validateTmuxGcDeadProcessEvidence;
  const identity = identityForTmux(700);
  const stored = {
    session: 'hcc-root-peer',
    session_created: '100',
    session_id: '$1',
    root: '/repo',
    pane: '%7',
    process_identity: identity
  };
  const observed = {
    session: stored.session,
    session_created: stored.session_created,
    session_id: stored.session_id,
    root: stored.root,
    pane: stored.pane,
    pane_pid: identity.pid,
    pane_dead: true,
    process_inspection: { state: 'dead', identity: null },
    clients: { state: 'known', count: 0 }
  };

  assert.deepEqual(validate(stored, observed), { ok: true });
  assert.deepEqual(validate(stored, {
    ...observed,
    process_inspection: { state: 'live', identity }
  }), { ok: false, reason: 'tmux_process_not_confirmed_dead' });
  assert.deepEqual(validate(stored, {
    ...observed,
    process_inspection: {
      state: 'live',
      identity: { ...identity, startToken: 'boot:reused' }
    }
  }), { ok: false, reason: 'tmux_process_not_confirmed_dead' });
  assert.deepEqual(validate(stored, {
    ...observed,
    process_inspection: { state: 'unknown', identity: null }
  }), { ok: false, reason: 'tmux_process_not_confirmed_dead' });
  assert.deepEqual(validate(stored, { ...observed, pane_pid: 701 }), {
    ok: false,
    reason: 'tmux_dead_process_pid_changed'
  });
  assert.deepEqual(validate(stored, { ...observed, pane_dead: false }), {
    ok: false,
    reason: 'tmux_pane_not_dead'
  });
  assert.deepEqual(validate(stored, { ...observed, session_created: '200' }), {
    ok: false,
    reason: 'tmux_session_reused'
  });
  assert.deepEqual(validate(stored, { ...observed, clients: { state: 'unknown' } }), {
    ok: false,
    reason: 'tmux_clients_unknown'
  });
});

test('tmux binding GC selects only strict explicit-exit-live or dead-process modes', async () => {
  const tmuxSafety = await import('../lib/core/peers/tmux-safety.mjs').catch(() => ({}));
  assert.equal(typeof tmuxSafety.validateTmuxGcBindingEvidence, 'function');
  const validate = tmuxSafety.validateTmuxGcBindingEvidence;
  const identity = identityForTmux(700);
  const authority = {
    session: 'hcc-root-peer',
    session_created: '100',
    session_id: '$1',
    root: '/repo',
    pane: '%7',
    process_identity: identity
  };
  const subject = {
    peer: 'peer',
    status: 'exited',
    transport: 'tmux',
    runtime_target: authority.pane,
    expected_session: authority.session,
    expected_root: authority.root,
    authority
  };
  const liveObserved = {
    ...authority,
    pane_pid: identity.pid,
    pane_dead: false,
    process_identity: identity,
    process_inspection: { state: 'live', identity },
    clients: { state: 'known', count: 0 }
  };
  const deadObserved = {
    ...liveObserved,
    pane_dead: true,
    process_identity: null,
    process_inspection: { state: 'dead', identity: null }
  };

  assert.deepEqual(validate(subject, liveObserved), { ok: true, mode: 'explicit_exit_live' });
  assert.deepEqual(validate({
    ...subject,
    owner_evidence: { state: 'live', reason: 'process_identity_match' }
  }, liveObserved), { ok: false, reason: 'tmux_owner_process_live' });
  assert.deepEqual(validate({ ...subject, status: 'idle' }, deadObserved), { ok: true, mode: 'dead_process' });
  assert.deepEqual(validate(subject, {
    ...liveObserved,
    process_identity: { ...identity, startToken: 'boot:reused' },
    process_inspection: {
      state: 'live',
      identity: { ...identity, startToken: 'boot:reused' }
    }
  }), { ok: false, reason: 'tmux_process_changed' });
  assert.deepEqual(validate(subject, {
    ...liveObserved,
    clients: { state: 'unknown', count: null }
  }), { ok: false, reason: 'tmux_clients_unknown' });
  assert.deepEqual(validate({ ...subject, authority: null }, liveObserved), {
    ok: false,
    reason: 'tmux_binding_subject_incomplete'
  });
});

test('tmux binding GC final section rolls back subject, kill, and CAS failures', async (t) => {
  const tmuxSafety = await import('../lib/core/peers/tmux-safety.mjs').catch(() => ({}));
  assert.equal(typeof tmuxSafety.finalizeTmuxGcBindingMutation, 'function');
  const finalize = tmuxSafety.finalizeTmuxGcBindingMutation;
  const createDb = () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE subject(value TEXT NOT NULL);
      CREATE TABLE peer(status TEXT NOT NULL);
      INSERT INTO subject VALUES ('planned');
      INSERT INTO peer VALUES ('exited');
    `);
    return db;
  };
  const callbacks = (db, overrides = {}) => ({
    db,
    plannedSubject: 'planned',
    readSubject: () => db.prepare('SELECT value FROM subject').get().value,
    sameSubject: (planned, current) => planned === current,
    conditionalKill: () => {},
    casBinding: () => db.prepare("UPDATE subject SET value = 'detached' WHERE value = 'planned'").run(),
    updatePeer: () => db.prepare("UPDATE peer SET status = 'detached'").run(),
    ...overrides
  });

  if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0) {
    const { runTmux } = await import('../lib/tmux.mjs');
    const session = `hcc-finalize-drift-${process.pid}`;
    try {
      try { runTmux(['kill-session', '-t', session]); } catch {}
      runTmux(['new-session', '-d', '-s', session, 'sleep', '120']);
      const format = runTmux(['display-message', '-p', '-t', session,
        '#{session_created}|#{session_id}|#{pane_id}|#{pane_pid}']).trim().split('|');
      const stored = {
        session,
        session_created: format[0],
        session_id: format[1],
        pane: format[2],
        process_identity: identityForTmux(Number(format[3]))
      };
      const db = createDb();
      try {
        assert.throws(() => finalize(callbacks(db, {
          beforeBegin: () => db.prepare("UPDATE subject SET value = 'changed'").run(),
          conditionalKill: () => tmuxSafety.conditionalTmuxKill(runTmux, stored)
        })), (error) => error?.code === 'TMUX_GC_BINDING_SUBJECT_CHANGED');
        assert.equal(runTmux(['has-session', '-t', session]), '');
        assert.equal(db.prepare('SELECT status FROM peer').get().status, 'exited');
      } finally {
        db.close();
      }
    } finally {
      try { runTmux(['kill-session', '-t', session]); } catch {}
    }
  } else {
    t.diagnostic('tmux unavailable; real subject-drift session check skipped');
  }

  {
    const db = createDb();
    try {
      assert.throws(() => finalize(callbacks(db, {
        conditionalKill: () => { throw new Error('conditional mismatch'); }
      })), /conditional mismatch/);
      assert.equal(db.prepare('SELECT value FROM subject').get().value, 'planned');
      assert.equal(db.prepare('SELECT status FROM peer').get().status, 'exited');
    } finally {
      db.close();
    }
  }

  {
    const db = createDb();
    let peerUpdates = 0;
    try {
      assert.throws(() => finalize(callbacks(db, {
        casBinding: () => ({ changes: 0 }),
        updatePeer: () => { peerUpdates += 1; }
      })), (error) => error?.code === 'TMUX_GC_BINDING_CAS_FAILED');
      assert.equal(peerUpdates, 0);
      assert.equal(db.prepare('SELECT value FROM subject').get().value, 'planned');
      assert.equal(db.prepare('SELECT status FROM peer').get().status, 'exited');
    } finally {
      db.close();
    }
  }
});

test('tmux binding GC final section blocks a concurrent writer through commit', async () => {
  const { finalizeTmuxGcBindingMutation } = await import('../lib/core/peers/tmux-safety.mjs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-tmux-gc-finalize-'));
  const dbPath = path.join(tempDir, 'mesh.db');
  const startPath = path.join(tempDir, 'start');
  const attemptedPath = path.join(tempDir, 'attempted');
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE subject(value TEXT NOT NULL);
    CREATE TABLE peer(status TEXT NOT NULL);
    CREATE TABLE writer(value TEXT NOT NULL);
    INSERT INTO subject VALUES ('planned');
    INSERT INTO peer VALUES ('exited');
  `);
  const childScript = `
    import fs from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    const [dbPath, startPath, attemptedPath] = process.argv.slice(1);
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(startPath)) Atomics.wait(wait, 0, 0, 5);
    fs.writeFileSync(attemptedPath, '1');
    const db = new DatabaseSync(dbPath, { timeout: 5000 });
    db.exec('BEGIN IMMEDIATE;');
    db.prepare("INSERT INTO writer VALUES ('committed')").run();
    db.exec('COMMIT;');
    db.close();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, dbPath, startPath, attemptedPath], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let childStderr = '';
  child.stderr.on('data', (chunk) => { childStderr += chunk; });
  const childExit = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  try {
    finalizeTmuxGcBindingMutation({
      db,
      plannedSubject: 'planned',
      readSubject: () => db.prepare('SELECT value FROM subject').get().value,
      sameSubject: (planned, current) => planned === current,
      conditionalKill: () => {
        fs.writeFileSync(startPath, '1');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 3000;
        while (!fs.existsSync(attemptedPath) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 5);
        assert.equal(fs.existsSync(attemptedPath), true);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM writer').get().count, 0);
      },
      casBinding: () => db.prepare("UPDATE subject SET value = 'detached' WHERE value = 'planned'").run(),
      updatePeer: () => db.prepare("UPDATE peer SET status = 'detached'").run()
    });
    const childResult = await childExit;
    assert.equal(childResult.code, 0, childStderr);
    assert.equal(childResult.signal, null);
    assert.equal(db.prepare('SELECT value FROM subject').get().value, 'detached');
    assert.equal(db.prepare('SELECT status FROM peer').get().status, 'detached');
    assert.equal(db.prepare('SELECT value FROM writer').get().value, 'committed');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('conditional tmux kill leaves a replacement created after prevalidation alive', async (t) => {
  if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) {
    t.skip('tmux unavailable');
    return;
  }
  const tmuxSafety = await import('../lib/core/peers/tmux-safety.mjs');
  const { runTmux } = await import('../lib/tmux.mjs');
  assert.equal(typeof tmuxSafety.conditionalTmuxKill, 'function');
  const session = `hcc-conditional-test-${process.pid}`;
  try {
    try { runTmux(['kill-session', '-t', session]); } catch {}
    runTmux(['new-session', '-d', '-s', session, 'sleep', '120']);
    const format = runTmux(['display-message', '-p', '-t', session,
      '#{session_created}|#{session_id}|#{pane_id}|#{pane_pid}']).trim().split('|');
    const stored = {
      session,
      session_created: format[0],
      session_id: format[1],
      pane: format[2],
      process_identity: identityForTmux(Number(format[3]))
    };
    assert.throws(() => tmuxSafety.conditionalTmuxKill(runTmux, stored, {
      beforeConditional: () => {
        runTmux(['kill-session', '-t', session]);
        runTmux(['new-session', '-d', '-s', session, 'sleep', '120']);
      }
    }), (error) => error?.code === 'TMUX_CONDITIONAL_KILL_MISMATCH');
    assert.equal(runTmux(['has-session', '-t', session]), '');
  } finally {
    try { runTmux(['kill-session', '-t', session]); } catch {}
  }
});

test('conditional tmux rename leaves a replacement created after prevalidation untouched', async (t) => {
  if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) {
    t.skip('tmux unavailable');
    return;
  }
  const tmuxSafety = await import('../lib/core/peers/tmux-safety.mjs');
  const { runTmux, tmuxHasSession } = await import('../lib/tmux.mjs');
  const session = `hcc-conditional-rename-${process.pid}`;
  const parked = `${session}-old`;
  try {
    try { runTmux(['kill-session', '-t', session]); } catch {}
    try { runTmux(['kill-session', '-t', parked]); } catch {}
    runTmux(['new-session', '-d', '-s', session, 'sleep', '120']);
    const format = runTmux(['display-message', '-p', '-t', session,
      '#{session_created}|#{session_id}|#{pane_id}|#{pane_pid}']).trim().split('|');
    const stored = {
      session,
      session_created: format[0],
      session_id: format[1],
      pane: format[2],
      process_identity: identityForTmux(Number(format[3]))
    };
    assert.throws(() => tmuxSafety.conditionalTmuxRename(runTmux, stored, parked, {
      beforeConditional: () => {
        runTmux(['kill-session', '-t', session]);
        runTmux(['new-session', '-d', '-s', session, 'sleep', '120']);
      }
    }), (error) => error?.code === 'TMUX_CONDITIONAL_RENAME_MISMATCH');
    assert.equal(tmuxHasSession(session), true);
    assert.equal(tmuxHasSession(parked), false);
  } finally {
    try { runTmux(['kill-session', '-t', session]); } catch {}
    try { runTmux(['kill-session', '-t', parked]); } catch {}
  }
});

test('conditional tmux rename parks the exact unattached session', async (t) => {
  if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) {
    t.skip('tmux unavailable');
    return;
  }
  const { conditionalTmuxRename } = await import('../lib/core/peers/tmux-safety.mjs');
  const { runTmux, tmuxHasSession } = await import('../lib/tmux.mjs');
  const session = `hcc-conditional-success-${process.pid}`;
  const parked = `${session}-old`;
  try {
    try { runTmux(['kill-session', '-t', session]); } catch {}
    try { runTmux(['kill-session', '-t', parked]); } catch {}
    runTmux(['new-session', '-d', '-s', session, 'sleep', '120']);
    const format = runTmux(['display-message', '-p', '-t', session,
      '#{session_created}|#{session_id}|#{pane_id}|#{pane_pid}']).trim().split('|');
    conditionalTmuxRename(runTmux, {
      session,
      session_created: format[0],
      session_id: format[1],
      pane: format[2],
      process_identity: identityForTmux(Number(format[3]))
    }, parked);
    const names = new Set(runTmux(['list-sessions', '-F', '#{session_name}'])
      .trim().split('\n').filter(Boolean));
    assert.equal(names.has(session), false);
    assert.equal(names.has(parked), true);
  } finally {
    try { runTmux(['kill-session', '-t', session]); } catch {}
    try { runTmux(['kill-session', '-t', parked]); } catch {}
  }
});

test('conditional tmux rename atomically checks identity and attached clients', async () => {
  const { conditionalTmuxRename } = await import('../lib/core/peers/tmux-safety.mjs');
  let command = null;
  const stored = {
    session: 'hcc-root-peer',
    session_created: '100',
    session_id: '$1',
    pane: '%7',
    process_identity: identityForTmux(700)
  };
  assert.deepEqual(conditionalTmuxRename((args) => {
    command = args;
    return 'HCC_CONDITIONAL_RENAME_OK\n';
  }, stored, 'hcc-root-peer-old'), {
    renamed: true,
    session: 'hcc-root-peer-old'
  });
  assert.match(command[4], /session_created/);
  assert.match(command[4], /session_attached/);
  assert.match(command[5], /rename-session -t '\$1' hcc-root-peer-old/);
  assert.throws(
    () => conditionalTmuxRename(() => 'HCC_CONDITIONAL_RENAME_MISMATCH\n', stored, 'hcc-root-peer-old'),
    (error) => error?.code === 'TMUX_CONDITIONAL_RENAME_MISMATCH'
  );
});

test('conditional tmux kill dead mode rechecks pane death atomically', async () => {
  const { conditionalTmuxKill } = await import('../lib/core/peers/tmux-safety.mjs');
  let command = null;
  const stored = {
    session: 'hcc-root-peer',
    session_created: '100',
    session_id: '$1',
    pane: '%7',
    process_identity: identityForTmux(700)
  };
  conditionalTmuxKill((args) => {
    command = args;
    return 'HCC_CONDITIONAL_KILL_OK\n';
  }, stored, { requireDeadPane: true });

  assert.match(command[4], /#\{pane_dead\}/);
});

test('conditional tmux kill preserves classified runner failures', async () => {
  const { conditionalTmuxKill } = await import('../lib/core/peers/tmux-safety.mjs');
  const { CliError } = await import('../lib/shared/errors.mjs');
  const stored = {
    session: 'hcc-root-peer',
    session_created: '100',
    session_id: '$1',
    pane: '%7',
    process_identity: identityForTmux(700)
  };
  for (const [code, message] of [
    ['TMUX_CONDITIONAL_KILL_TIMEOUT', 'tmux conditional kill exceeded 5000ms'],
    ['TMUX_ERROR', 'tmux server unavailable']
  ]) {
    const classified = new CliError(code, message, { operation: 'conditional-kill' });
    assert.throws(
      () => conditionalTmuxKill(() => { throw classified; }, stored),
      (error) => error === classified &&
        error.code === code &&
        error.message === message &&
        error.extra.operation === 'conditional-kill'
    );
  }
});

test('conditional tmux kill wraps an unexpected runner failure as infrastructure error', async () => {
  const { conditionalTmuxKill } = await import('../lib/core/peers/tmux-safety.mjs');
  const stored = {
    session: 'hcc-root-peer',
    session_created: '100',
    session_id: '$1',
    pane: '%7',
    process_identity: identityForTmux(700)
  };
  assert.throws(
    () => conditionalTmuxKill(() => { throw new Error('spawn failed'); }, stored),
    (error) => error?.code === 'TMUX_ERROR' &&
      error.message.includes('Conditional tmux kill command failed') &&
      error.message.includes('spawn failed')
  );
});

function identityForTmux(pid) {
  return { pid, startToken: `boot:${pid}`, commandHash: HASH_A };
}
