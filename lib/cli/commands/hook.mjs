// Hook command extracted from bin/hcc.mjs.
// This is the provider hook entry point called by Claude/Codex hooks.

export function createHookCommand(deps) {
  const {
    connect, now, addEvent, auditPayload,
    registerProjectActivity, touchCurrentPeer,
    liveProcessIdentity, detectBranch,
    resolveCurrentPeer, providerSessionPeerId, providerSessionParts,
    readAncestorCliInfo, latestHookProviderSession, formatHookEventName,
    upsertPeer, upsertCanonicalPeerBinding,
    autoPeerKind, autoPeerBasis, autoPeerProviderSession,
    observeLockClockSafety, observePeerEvidence,
    buildHookCoordinationContext, ackMessages,
    reconcileRunningPeerBindings, inspectProviderProcess,
    resumeIdFromArgs, shortHash, renewOwnedLocks, refreshHookOwnerIdentity,
    path, fs, process, CliError
  } = deps;

async function cmdHook(ctx, args) {
  let hookType = args[0] || 'unknown';

  // Read stdin with a short timeout (hooks must complete quickly)
  const raw = await new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(buf), 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(buf); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(buf); });
  });

  let payload = {};
  try { payload = JSON.parse(raw); } catch {}
  hookType = payload.hook_event_name || payload.hookEventName || hookType;
  const hookEventName = formatHookEventName(hookType);
  const hookKey = hookEventName.replace(/[^a-z]/gi, '').toLowerCase();

  // Extract session identity (Claude Code sets these in its hook JSON)
  const kind = autoPeerKind('other');
  const providerSession = autoPeerProviderSession(kind);
  const sessionId  = payload.session_id || payload.sessionId || payload.conversation_id || payload.conversationId ||
    providerSession.sessionId || '';
  const hookCwd    = payload.cwd         || payload.workingDirectory || process.cwd();

  // Hooks auto-join the exact current project path, creating its mesh.db on
  // first use. Cross-path sharing is explicit via HCC_ROOT/HCC_DB.
  const hccRoot = process.env.HCC_ROOT
    ? path.resolve(process.env.HCC_ROOT)
    : path.resolve(hookCwd);

  const hookCtx = {
    ...ctx,
    root: hccRoot,
    dbPath: path.join(hccRoot, '.hello-cc', 'mesh.db')
  };
  registerProjectActivity(hookCtx);

  // Derive peer ID: HCC_PEER > resume ID from parent cmdline > session ID > terminal
  let peerId = process.env.HCC_PEER;
  let resumeId = null;
  if (!peerId) {
    resumeId = providerSession.resumeId || readParentResumeId(kind);
    if (resumeId) {
      peerId = providerSessionPeerId(kind, resumeId);
    }
  }
  if (!peerId) {
    peerId = sessionId
      ? `${kind}-${shortHash(sessionId)}`
      : `${kind}-${shortHash(`${hookCtx.root}:${autoPeerBasis(kind)}`)}`;
  }

  const db = connect(hookCtx);
  try {
    const status = hookKey === 'stop' ? 'idle' : 'working';
    const providerAncestor = readAncestorCliInfo();
    const providerPid = providerAncestor?.kind === kind ? Number(providerAncestor.pid) : null;
    const providerIdentity = providerPid ? liveProcessIdentity(providerPid) : null;
    const existing = db.prepare('SELECT id FROM peers WHERE id = ?').get(peerId);
    if (!existing) {
      upsertPeer(db, {
        id: peerId, kind, role: 'peer',
        worktree: hookCwd,
        branch: detectBranch(hookCwd),
        pid: providerIdentity?.pid || null,
        processIdentity: providerIdentity,
        status,
        capabilities: `hook-${hookKey}`
      });
    } else {
      refreshHookOwnerIdentity(db, {
        peerId,
        status,
        observedAt: now(),
        processIdentity: providerIdentity
      });
    }
    const hookBinding = {
      peer: peerId,
      provider: kind,
      ...providerSessionParts(resumeId || sessionId),
      resume_mode: resumeId ? 'resume' : (sessionId ? 'detected' : 'unknown'),
      resume_arg: resumeId || null,
      command: null,
      transport: 'hook',
      runtime_session_id: peerId
    };
    const canonical = upsertCanonicalPeerBinding(db, hookBinding, true);
    if (canonical.peer !== peerId) {
      const previousPeer = peerId;
      peerId = canonical.peer;
      refreshHookOwnerIdentity(db, {
        peerId,
        status,
        observedAt: now(),
        processIdentity: providerIdentity
      });
      addEvent(db, 'provider.session.merged', peerId, null, auditPayload({
        actor: peerId,
        target: peerId,
        source: 'hook',
        from_peer: previousPeer,
        provider: kind,
        session_id: sessionId || resumeId || null
      }));
    }
    addEvent(db, `hook.${hookKey}`, peerId, null, auditPayload({
      actor: peerId,
      target: peerId,
      source: 'hook',
      session_id: sessionId,
      cwd: hookCwd
    }));
    // hb-06: an active hook is proof the peer is working. During clock grace,
    // renew retained locks even when the wall-clock jump made them look expired.
    const hookNow = now();
    const hookClockObservation = observeLockClockSafety(db, hookCtx, {
      owner: peerId,
      observedAt: hookNow
    });
    const hookLockRenewals = hookClockObservation.renewed > 0
      ? hookClockObservation.renewed
      : renewOwnedLocks(db, {
          owner: peerId,
          nowSec: hookNow,
          ttlCap: 3600,
          // Receiving the hook is direct lease-heartbeat evidence. It does not
          // grant provider-restart or tmux-destructive authority.
          includeExpired: true
        });
    if (hookLockRenewals > 0) {
      addEvent(db, 'lock.renewed_by_hook', peerId, null, { renewed: hookLockRenewals });
    }
    try {
      reconcileRunningPeerBindings(db, hookCtx, {
        inspectProcess: inspectProviderProcess,
        latestProviderSessionForPeer: (peer) => latestHookProviderSession(db, peer),
        addEvent,
        now
      });
    } catch {}

    if (['sessionstart', 'userpromptsubmit'].includes(hookKey)) {
      const snapshot = buildHookCoordinationContext(db, hookCtx, peerId);
      ackMessages(db, peerId, snapshot.messages);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName,
          additionalContext: snapshot.text
        }
      }) + '\n');
    } else if (['posttooluse', 'stop'].includes(hookKey)) {
      const snapshot = buildHookCoordinationContext(db, hookCtx, peerId);
      if (snapshot.messages.length > 0) {
        ackMessages(db, peerId, snapshot.messages);
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName,
            additionalContext: snapshot.text
          }
        }) + '\n');
      }
    }
  } finally {
    try { db.close(); } catch {}
  }
  process.exit(0);
}

// ─── hcc install-hooks ───────────────────────────────────────────────────────


  return { cmdHook };
}

function readParentResumeId(kind) {
  if (process.platform !== 'linux') return null;
  try {
    const raw = fs.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8');
    const args = raw.split('\0').filter(Boolean);
    return resumeIdFromArgs(kind, args);
  } catch {}
  return null;
}
