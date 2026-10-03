// Hook command extracted from bin/hcc.mjs.
// This is the provider hook entry point called by Claude/Codex/dsh hooks.

import { parseOpts, validateOpts } from '../../cli-args.mjs';
import { tx } from '../../db/schema.mjs';
import { resolveProjectDatabase } from '../../runtime/project-path.mjs';
import { projectDbPath } from '../../runtime/paths.mjs';

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
  const opts = parseOpts(args);
  let hookType = opts._.shift() || 'unknown';
  validateOpts('hook', opts, ['provider']);
  if (opts.provider !== undefined && !['claude', 'codex', 'dsh'].includes(opts.provider)) {
    throw new CliError('BAD_ARGS', 'hook: --provider must be claude, codex, or dsh');
  }
  const kind = opts.provider || autoPeerKind('other');
  const isDsh = kind === 'dsh';
  const nativeOwner = process.env.HCC_NATIVE_OWNER || null;
  if (nativeOwner && (!process.env.HCC_PEER || !process.env.HCC_ROOT || !process.env.HCC_DB)) {
    throw new CliError('NATIVE_HOOK_OWNERSHIP_MISMATCH', 'Native hook needs an explicit worker peer, root, and database');
  }

  // Read stdin with a short timeout (hooks must complete quickly)
  const raw = await new Promise((resolve) => {
    let buf = '';
    const finish = () => {
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', finish);
      process.stdin.removeListener('error', finish);
      process.stdin.pause();
      resolve(buf);
    };
    const onData = (c) => { buf += c; };
    const timer = setTimeout(finish, 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });

  let payload = {};
  try { payload = JSON.parse(raw); } catch {}
  if (isDsh && (!payload || typeof payload !== 'object' || Array.isArray(payload))) {
    throw new CliError('BAD_HOOK_PAYLOAD', 'dsh hook requires a JSON object with session_id and cwd');
  }
  // Keep ordinary hooks tolerant of malformed/empty input as before.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
  hookType = payload.hook_event_name || payload.hookEventName || hookType;
  if (isDsh && typeof hookType !== 'string') {
    throw new CliError('BAD_HOOK_PAYLOAD', 'dsh hook requires a valid hook event');
  }
  const hookEventName = formatHookEventName(hookType);
  const hookKey = hookEventName.replace(/[^a-z]/gi, '').toLowerCase();
  if (isDsh && !['sessionstart', 'userpromptsubmit', 'pretooluse', 'posttooluse', 'stop'].includes(hookKey)) {
    throw new CliError('BAD_HOOK_PAYLOAD', 'Unsupported dsh hook event');
  }

  // A dsh service can host many sessions and workspaces. Only its per-hook
  // payload identifies the conversation; service environment belongs to none.
  const providerSession = isDsh ? {} : autoPeerProviderSession(kind);
  const sessionId = isDsh
    ? payload.session_id
    : payload.session_id || payload.sessionId || payload.conversation_id || payload.conversationId || providerSession.sessionId || '';
  const hookCwd = isDsh ? payload.cwd : payload.cwd || payload.workingDirectory || process.cwd();
  if (isDsh) validateDshHookIdentity(sessionId, hookCwd);

  // Hooks auto-join the exact current project path, creating its mesh.db on
  // first use. Ordinary hooks allow explicit cross-path sharing via HCC_ROOT.
  const hccRoot = (nativeOwner || !isDsh) && process.env.HCC_ROOT
    ? path.resolve(process.env.HCC_ROOT)
    : path.resolve(hookCwd);

  const dshProject = isDsh && !nativeOwner ? resolveProjectDatabase({ root: hccRoot, createStateDir: false }) : null;
  const nativeProject = nativeOwner ? resolveProjectDatabase({ root: hccRoot,
    db: process.env.HCC_DB, createStateDir: false }) : null;
  const ordinaryDb = (ctx.root && path.resolve(ctx.root) === hccRoot ? ctx.dbPath : null) ||
    process.env.HCC_DB;
  if (nativeProject && !fs.existsSync(nativeProject.db)) {
    throw new CliError('NATIVE_HOOK_OWNERSHIP_MISMATCH', 'Native hook database must already be owned by its runtime');
  }
  const ordinaryDefaultDb = !dshProject && !nativeProject && !ordinaryDb
    ? projectDbPath(hccRoot) : null;
  const hookCtx = {
    ...ctx,
    root: nativeProject?.root || dshProject?.root || hccRoot,
    dbPath: nativeProject?.db || dshProject?.db || ordinaryDefaultDb || path.resolve(ordinaryDb)
  };
  if (!nativeOwner) registerProjectActivity(hookCtx);

  // dsh uses only its true session ID. Ordinary hooks retain environment,
  // resume, session, and terminal identity precedence.
  let peerId = isDsh && !nativeOwner ? providerSessionPeerId(kind, sessionId) : process.env.HCC_PEER;
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

  // Hook delivery must not migrate another workspace's registered database.
  const db = isDsh || nativeOwner ? connect(hookCtx, { migrateRegistered: false }) : connect(hookCtx);
  try {
    if (nativeOwner) {
      // Native delivery owns context injection and completion receipts. Hooks
      // only renew its verified owner, never turn a native binding into a
      // terminal binding or consume the same inbox through a second path.
      tx(db, () => {
        const binding = db.prepare(`
          SELECT b.*, p.kind AS peer_kind FROM peer_bindings b
          JOIN peers p ON p.id = b.peer WHERE b.peer = ?
        `).get(peerId);
        if (!binding || binding.transport !== 'native' || binding.runtime_target !== nativeOwner ||
            binding.peer_kind !== binding.provider || (opts.provider && binding.provider !== kind)) {
          throw new CliError('NATIVE_HOOK_OWNERSHIP_MISMATCH', 'Native hook does not match its runtime-owned peer binding');
        }
        const observedAt = now();
        db.prepare('UPDATE peers SET last_seen_at = ? WHERE id = ?').run(observedAt, peerId);
        const renewed = renewOwnedLocks(db, { owner: peerId, nowSec: observedAt,
          ttlCap: 3600, includeExpired: true });
        if (renewed > 0) addEvent(db, 'lock.renewed_by_hook', peerId, null, { renewed, source: 'native-hook' });
      });
      process.exitCode = 0;
      return;
    }
    const status = hookKey === 'stop' ? 'idle' : 'working';
    const providerAncestor = readAncestorCliInfo(isDsh ? 'dsh' : undefined);
    const providerPid = providerAncestor?.kind === kind ? Number(providerAncestor.pid) : null;
    const providerIdentity = providerPid ? liveProcessIdentity(providerPid) : null;
    const registerHookIdentity = () => {
      if (isDsh) assertDshHookBinding(db, peerId, sessionId);
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
        ...(isDsh
          ? { provider_session_id: sessionId, provider_session_name: null }
          : providerSessionParts(resumeId || sessionId)),
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
    };
    // Keep the dsh conflict check and identity/binding writes atomic, so a
    // concurrent service/session registration cannot change the inspected row.
    if (isDsh) tx(db, registerHookIdentity);
    else registerHookIdentity();
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
    if (!isDsh) {
      try {
        reconcileRunningPeerBindings(db, hookCtx, {
          inspectProcess: inspectProviderProcess,
          latestProviderSessionForPeer: (peer) => latestHookProviderSession(db, peer),
          addEvent,
          now
        });
      } catch {}
    }

    if (['sessionstart', 'userpromptsubmit'].includes(hookKey)) {
      const snapshot = buildHookCoordinationContext(db, hookCtx, peerId);
      await writeHookOutput({
        hookSpecificOutput: {
          hookEventName,
          additionalContext: snapshot.text
        }
      });
      ackMessages(db, peerId, snapshot.messages);
    } else if (hookKey === 'posttooluse') {
      const snapshot = buildHookCoordinationContext(db, hookCtx, peerId);
      if (snapshot.messages.length > 0) {
        await writeHookOutput({
          hookSpecificOutput: {
            hookEventName,
            additionalContext: snapshot.text
          }
        });
        ackMessages(db, peerId, snapshot.messages);
      }
    } else if (hookKey === 'stop' && payload.stop_hook_active !== true) {
      // A blocking Stop hook causes another model turn. Do not block that
      // continuation again; newly arrived messages stay unread for the next
      // SessionStart, UserPromptSubmit, PostToolUse, or independent Stop.
      const snapshot = buildHookCoordinationContext(db, hookCtx, peerId);
      if (snapshot.messages.length > 0) {
        await writeHookOutput({
          decision: 'block',
          reason: snapshot.text
        });
        ackMessages(db, peerId, snapshot.messages);
      }
    }
  } finally {
    try { db.close(); } catch {}
  }
  // Let Node exit after the hook output has flushed instead of truncating a
  // pipe with process.exit(). A successful write is not provider acceptance.
  process.exitCode = 0;
}

function writeHookOutput(output) {
  return new Promise((resolve, reject) => {
    const stdout = process.stdout;
    const onError = (error) => reject(error);
    stdout.once('error', onError);
    try {
      stdout.write(JSON.stringify(output) + '\n', (error) => {
        if (error) {
          // Writable emits its error after invoking the callback. Keep the
          // once listener until that event so a failed pipe is handled.
          reject(error);
        } else {
          stdout.removeListener('error', onError);
          resolve();
        }
      });
    } catch (error) {
      stdout.removeListener('error', onError);
      reject(error);
    }
  });
}

function validateDshHookIdentity(sessionId, cwd) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 1024 ||
      sessionId.trim() !== sessionId || /[\u0000-\u001f\u007f]/.test(sessionId)) {
    throw new CliError('BAD_HOOK_PAYLOAD', 'dsh hook requires a nonempty string session_id');
  }
  if (typeof cwd !== 'string' || !cwd || /[\u0000-\u001f\u007f]/.test(cwd) || !path.isAbsolute(cwd)) {
    throw new CliError('BAD_HOOK_PAYLOAD', 'dsh hook requires an absolute cwd directory');
  }
  let isDirectory = false;
  try { isDirectory = fs.statSync(cwd).isDirectory(); } catch {}
  if (!isDirectory) throw new CliError('BAD_HOOK_PAYLOAD', 'dsh hook cwd must be an existing directory');
}

function assertDshHookBinding(db, peerId, sessionId) {
  const conflict = (reason, boundPeer = peerId) => {
    throw new CliError('DSH_PEER_BINDING_CONFLICT',
      `dsh hook session ${sessionId} conflicts with existing peer binding ${boundPeer}`, {
        peer: peerId, bound_peer: boundPeer, session_id: sessionId, reason
      });
  };
  const peer = db.prepare('SELECT kind FROM peers WHERE id = ?').get(peerId);
  if (peer && peer.kind !== 'dsh') conflict('peer_provider_mismatch');
  const binding = db.prepare('SELECT * FROM peer_bindings WHERE peer = ?').get(peerId);
  if (binding) {
    if (binding.provider !== 'dsh') conflict('binding_provider_mismatch');
    if (binding.transport !== 'hook' || binding.runtime_target !== null) conflict('runtime_binding');
    if (binding.provider_session_id !== sessionId || binding.provider_session_name !== null) {
      conflict('session_id_mismatch');
    }
  }
  const alias = db.prepare(`
    SELECT peer FROM peer_bindings
    WHERE provider = 'dsh' AND peer <> ?
      AND (provider_session_id = ? OR provider_session_name = ?)
    LIMIT 1
  `).get(peerId, sessionId, sessionId);
  if (alias) conflict('session_bound_to_another_peer', alias.peer);
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

  return { cmdHook };
}
