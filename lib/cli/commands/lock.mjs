// Lock CLI commands extracted from bin/hcc.mjs.
// Factory pattern with injected deps.

export function createLockCommands(deps) {
  const {
    connect,
    now,
    iso,
    tx,
    addEvent,
    touchCurrentPeer,
    resolveCurrentPeer,
    parseOpts,
    intOpt,
    required,
    positiveSafeIntOpt,
    wantsHelp,
    helpLock,
    printResult,
    table,
    CliError,
    DEFAULT_LOCK_TTL,
    leaseDeadline,
    scopedLockResource,
    lockLabel,
    lockScope,
    lockBaseResource,
    locksConflict,
    clockGraceSuppressed,
    readClockGraceUntil,
    clockSafetyUnavailable,
    captureLockAcquireSubject,
    sameLockAcquireSubject,
    observeLockOwnerEvidence,
    observePeerEvidence,
    prepareLockClockObservation,
    runOptimisticEvidenceMutation,
    assertTaskOwnerForMutation,
    notifyTaskOwnerConflict
  } = deps;

  async function cmdLock(ctx, args) {
    const sub = args[0];
    if (!sub || wantsHelp(args)) return helpLock();
    if (sub === 'acquire') return lockAcquire(ctx, args.slice(1));
    if (sub === 'release') return lockRelease(ctx, args.slice(1));
    if (sub === 'renew') return lockRenew(ctx, args.slice(1));
    if (sub === 'list') return lockList(ctx, args.slice(1));
    throw new CliError('BAD_ARGS', `Unknown lock command: ${sub}`);
  }

  async function lockAcquire(ctx, args) {
    const opts = parseOpts(args);
    const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
    const peer = identity.id;
    const requested = scopedLockResource(required(opts, 'resource'), opts.scope);
    const taskId = intOpt(opts, 'task', null);
    const ttl = positiveSafeIntOpt(opts, 'ttl', DEFAULT_LOCK_TTL);
    const reason = opts.reason || '';
    const acquisitionNow = now();
    leaseDeadline(acquisitionNow, ttl);
    const db = connect(ctx);
    touchCurrentPeer(db, ctx, identity, 'working', 'shell');
    let lock;
    try {
      const outcome = runOptimisticEvidenceMutation(db, {
        capture: (subjectDb) => {
          try {
            return captureLockAcquireSubject(subjectDb, {
              taskId,
              requested,
              now: acquisitionNow
            });
          } catch (err) {
            throw clockSafetyUnavailable(err);
          }
        },
        observe: (subject) => observeLockOwnerEvidence(subject, (row, binding) =>
          observePeerEvidence(ctx, row, binding)),
        same: sameLockAcquireSubject,
        beforeMutate: (subject, evidenceByOwner) =>
          prepareLockClockObservation(db, subject, evidenceByOwner),
        changedMessage: `Lock subjects changed while acquiring ${lockLabel(requested)}; retry`,
        mutate: (subject, evidenceByOwner, clockObservation) => {
          const t = subject.observedAt;
          if (taskId) {
            const task = subject.task;
            if (!task) throw new CliError('NOT_FOUND', `Task #${taskId} does not exist`);
            assertTaskOwnerForMutation(db, peer, task, 'lock-acquire');
          }
          const graceActive = clockGraceSuppressed(t, clockObservation.graceUntil);
          const activeLocks = graceActive
            ? subject.locks.filter((row) =>
                !(Number(row.expires_at) <= t && evidenceByOwner.get(row.owner)?.state === 'dead'))
            : subject.locks.filter((row) =>
                Number(row.expires_at) > t ||
                evidenceByOwner.get(row.owner)?.state === 'live'
              );
          const conflict = activeLocks.find((row) => locksConflict(row, requested) && row.owner !== peer);
          if (conflict) {
            return { error: new CliError('LOCK_HELD', `Resource ${lockLabel(requested)} conflicts with lock ${lockLabel(conflict)} held by ${conflict.owner}`, {
              resource: requested.base_resource,
              scope: requested.scope,
              lock_resource: conflict.resource,
              lock_scope: lockScope(conflict),
              owner: conflict.owner,
              expires_at: iso(conflict.expires_at)
            }) };
          }
          const existing = subject.locks.find((row) => row.resource === requested.resource) || null;
          const expiresAt = leaseDeadline(t, ttl);
          db.prepare(`
            INSERT INTO locks(resource, base_resource, scope, owner, task_id, reason, expires_at, created_at, ttl_sec)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(resource) DO UPDATE SET
              base_resource = excluded.base_resource,
              scope = excluded.scope,
              owner = excluded.owner,
              task_id = excluded.task_id,
              reason = excluded.reason,
              expires_at = excluded.expires_at,
              created_at = excluded.created_at,
              ttl_sec = excluded.ttl_sec
          `).run(requested.resource, requested.base_resource, requested.scope, peer, taskId, reason, expiresAt, t, ttl);
          addEvent(db, 'lock.acquired', peer, taskId, { resource: requested.base_resource, lock_resource: requested.resource, scope: requested.scope, ttl, previous_owner: existing ? existing.owner : null });
          return { lock: db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource) };
        }
      });
      if (outcome.error) throw outcome.error;
      lock = outcome.lock;
    } catch (err) {
      notifyTaskOwnerConflict(ctx, err);
      throw err;
    }
    printResult(ctx, lock, (data) => `locked ${lockLabel(data)} by ${data.owner} until ${iso(data.expires_at)}`);
  }

  async function lockRelease(ctx, args) {
    const opts = parseOpts(args, { booleans: ['force'] });
    const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
    const peer = identity.id;
    const requested = scopedLockResource(required(opts, 'resource'), opts.scope);
    const db = connect(ctx);
    touchCurrentPeer(db, ctx, identity, null, 'shell');
    const result = tx(db, () => {
      const existing = db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
      if (!existing) return { released: false, ...requested };
      if (existing.owner !== peer && !opts.force) {
        throw new CliError('LOCK_OWNED', `Lock is owned by ${existing.owner}`, { owner: existing.owner });
      }
      db.prepare('DELETE FROM locks WHERE resource = ?').run(requested.resource);
      addEvent(db, 'lock.released', peer, existing.task_id || null, { resource: requested.base_resource, lock_resource: requested.resource, scope: requested.scope, force: Boolean(opts.force) });
      return { released: true, ...requested };
    });
    printResult(ctx, result, (data) => data.released ? `released ${lockLabel(data)}` : `no lock for ${lockLabel(data)}`);
  }

  async function lockRenew(ctx, args) {
    const opts = parseOpts(args);
    const identity = resolveCurrentPeer(ctx, opts, 'peer', 'shell');
    const peer = identity.id;
    const requested = scopedLockResource(required(opts, 'resource'), opts.scope);
    const ttl = positiveSafeIntOpt(opts, 'ttl', DEFAULT_LOCK_TTL);
    const renewalNow = now();
    const expiresAt = leaseDeadline(renewalNow, ttl);
    const db = connect(ctx);
    touchCurrentPeer(db, ctx, identity, 'working', 'shell');
    const lock = tx(db, () => {
      const existing = db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
      if (!existing) throw new CliError('NOT_FOUND', `No lock for ${lockLabel(requested)}`);
      if (existing.owner !== peer) throw new CliError('LOCK_OWNED', `Lock is owned by ${existing.owner}`, { owner: existing.owner });
      db.prepare('UPDATE locks SET expires_at = ?, ttl_sec = ? WHERE resource = ?').run(expiresAt, ttl, requested.resource);
      addEvent(db, 'lock.renewed', peer, existing.task_id || null, { resource: requested.base_resource, lock_resource: requested.resource, scope: requested.scope, ttl });
      return db.prepare('SELECT * FROM locks WHERE resource = ?').get(requested.resource);
    });
    printResult(ctx, lock, (data) => `renewed ${lockLabel(data)} until ${iso(data.expires_at)}`);
  }

  async function lockList(ctx, args) {
    const opts = parseOpts(args, { booleans: ['all'] });
    const db = connect(ctx);
    const t = now();
    const rows = opts.all || clockGraceSuppressed(t, readClockGraceUntil(db))
      ? db.prepare('SELECT * FROM locks ORDER BY resource ASC').all()
      : db.prepare('SELECT * FROM locks WHERE expires_at > ? ORDER BY resource ASC').all(t);
    printResult(ctx, rows, (data) => table(data, [
      { label: 'resource', value: (r) => lockBaseResource(r) },
      { label: 'scope', value: (r) => lockScope(r) },
      { label: 'owner', value: (r) => r.owner },
      { label: 'task', value: (r) => r.task_id ? `#${r.task_id}` : '' },
      { label: 'expires', value: (r) => iso(r.expires_at) },
      { label: 'reason', value: (r) => r.reason || '' }
    ]));
  }

  return { cmdLock };
}
