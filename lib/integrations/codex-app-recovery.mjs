import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliError } from '../shared/errors.mjs';
import { tx } from '../db/schema.mjs';
import { createCodexAppCooperation } from './codex-app-cooperation.mjs';
import { createCodexAppDelivery, codexAppDeliveryStatus } from './codex-app-delivery.mjs';
import { createCodexAppQueueTransport, discoverCodexAppRuntime } from './codex-app-queue.mjs';

const prefix = 'codex-app.dispatch.recovery.';
const key = auth => prefix + auth.scope.peer;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const get = (db, auth) => {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key(auth));
  return row ? JSON.parse(row.value) : null;
};
const put = (db, auth, value) => db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  .run(key(auth), JSON.stringify(value));
function owned(auth, operation) {
  const db = auth.connect();
  try { return tx(db, () => { auth.assertOwnership(db); return operation(db); }); }
  finally { db.close(); }
}
const stateOf = setting => setting ? { enabled: setting.enabled, status: setting.status,
  error: setting.error || null, lastStartedAt: setting.lastStartedAt || null,
  activeHostPid: setting.activeHostPid || null } : { enabled: false, status: 'disabled', error: null };

// This opt-in names one previously enrolled thread. It contains no model
// capability, hook session_id, message body, or permission to restore a thread.
export function configureCodexAppRecovery({ root, sessionId, enabled, runtime,
  initialRootIdentity = null, now = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!uuid.test(sessionId || '') || typeof enabled !== 'boolean' || enabled &&
      !['cli', 'sqliteHome', 'appExecutable'].every(name => typeof runtime?.[name] === 'string' && path.isAbsolute(runtime[name]))) {
    throw new CliError('BAD_ARGS', 'Automatic recovery requires this current App thread and a verified original runtime');
  }
  const service = createCodexAppCooperation({ root, initialRootIdentity });
  const auth = service.deliveryAuthority(sessionId);
  return owned(auth, db => {
    const previous = get(db, auth);
    const setting = { version: 1, policyId: randomUUID(), sessionId, peer: auth.scope.peer, owner: auth.scope.executorId,
      enabled, status: enabled ? 'pending' : 'disabled', error: null, updatedAt: now(),
      ...(enabled ? { runtime: { cli: runtime.cli, sqliteHome: runtime.sqliteHome, appExecutable: runtime.appExecutable } } : {}),
      createdAt: previous?.createdAt || now() };
    put(db, auth, setting);
    return { root: auth.scope.root, sessionId, peer: auth.scope.peer, ...stateOf(setting) };
  });
}

export function codexAppRecoveryStatus({ root, sessionId, initialRootIdentity = null } = {}) {
  const auth = createCodexAppCooperation({ root, initialRootIdentity }).deliveryAuthority(sessionId);
  const setting = owned(auth, db => get(db, auth));
  if (setting && setting.owner !== auth.scope.executorId) return { enabled: false, status: 'revoked', error: 'CODEX_APP_SCOPE_INVALID' };
  const state = stateOf(setting);
  if (state.status === 'active') {
    const listener = codexAppDeliveryStatus({ root, sessionId, initialRootIdentity });
    if (!listener.running || listener.recoveryPolicyId !== setting.policyId) return { ...state,
      status: listener.running ? 'blocked' : 'pending', activeHostPid: null,
      error: listener.running ? 'CODEX_APP_DISPATCH_CONFLICT' : null };
  }
  return state;
}

// The original App starts this project MCP again when its plugin reconnects.
// That new process supplies fresh App/server ancestry. Only explicitly saved
// policies for this project and exact executable/home may start a dispatcher.
// The manager owns no App lifecycle and never starts/resumes/forks a thread.
export function createCodexAppRecoveryManager({ root, initialRootIdentity = null,
  discover = discoverCodexAppRuntime, createTransport = createCodexAppQueueTransport,
  createDelivery = createCodexAppDelivery, schedule = setInterval, unschedule = clearInterval,
  now = () => Math.floor(Date.now() / 1000), onStatus = () => {} } = {}) {
  const service = createCodexAppCooperation({ root, initialRootIdentity });
  const active = new Map();
  let closed = false, closing = false, currentTick = null, runtime = null;
  function update(auth, setting, values) {
    owned(auth, db => {
      const current = get(db, auth);
      if (!current || current.owner !== setting.owner || current.policyId !== setting.policyId || !current.enabled) return;
      if (Object.entries(values).every(([name, value]) => current[name] === value)) return;
      put(db, auth, { ...current, ...values });
    });
  }
  const notify = value => { try { onStatus(value); } catch {} };
  async function runTick() {
    let settings;
    try { settings = service.isEnabled() ? service.recoverySettings() : []; }
    catch (error) {
      for (const item of active.values()) await item.delivery.close();
      active.clear();
      notify({ error: error instanceof CliError ? error.code : 'CODEX_APP_RECOVERY_FAILED' });
      return;
    }
    const enabled = new Map(settings.filter(item => item.enabled === true).map(item => [item.peer, item]));
    for (const [peer, item] of active) {
      const setting = enabled.get(peer);
      if (!setting || setting.owner !== item.setting.owner || setting.policyId !== item.setting.policyId) {
        await item.delivery.close(); active.delete(peer);
      }
    }
    for (const setting of enabled.values()) {
      if (closing) break;
      let auth;
      try {
        auth = service.deliveryAuthority(setting.sessionId);
        if (setting.version !== 1 || !uuid.test(setting.policyId || '') || setting.peer !== auth.scope.peer || setting.owner !== auth.scope.executorId) {
          throw new CliError('CODEX_APP_SCOPE_INVALID', 'Automatic recovery policy belongs to a previous cooperation owner');
        }
        if (!active.has(setting.peer)) {
          const existing = codexAppDeliveryStatus({ root: service.ctx.root, sessionId: setting.sessionId, initialRootIdentity });
          if (existing.running && existing.recoveryPolicyId === setting.policyId) {
            // Several App threads can hold a project MCP connection. Reuse
            // that policy's live listener without changing or closing its lease.
            update(auth, setting, { status: existing.ready ? 'active' : 'blocked',
              error: existing.error, activeHostPid: existing.dispatcherPid });
            continue;
          }
          if (existing.running) throw new CliError('CODEX_APP_DISPATCH_CONFLICT', 'A different live dispatcher owns this thread');
          runtime ||= await discover();
          if (!['cli', 'sqliteHome', 'appExecutable'].every(name => runtime[name] === setting.runtime?.[name])) {
            throw new CliError('CODEX_APP_RECOVERY_RUNTIME_CHANGED', 'This MCP belongs to a different App installation or queue home');
          }
          const transport = await createTransport({ root: service.ctx.root, threadId: setting.sessionId, ...runtime });
          if (closing) break;
          const delivery = createDelivery({ root: service.ctx.root, sessionId: setting.sessionId,
            initialRootIdentity, transport, recoveryPolicyId: setting.policyId,
            schedule: () => null, unschedule: () => {}, onStatus: notify });
          active.set(setting.peer, { delivery, setting });
          update(auth, setting, { status: 'active', error: null, lastStartedAt: now(), activeHostPid: process.pid });
          notify({ peer: setting.peer, status: 'active', automaticRecovery: true });
        }
        const item = active.get(setting.peer);
        await item.delivery.tick();
        if (item.delivery.status().error) {
          throw new CliError(item.delivery.status().error, 'Automatic delivery stopped pending runtime validation');
        }
      } catch (error) {
        const item = active.get(setting.peer);
        if (item) { await item.delivery.close(); active.delete(setting.peer); }
        const code = error instanceof CliError ? error.code : 'CODEX_APP_RECOVERY_FAILED';
        // Failures never break the MCP protocol or relax its per-call scope.
        if (auth) try { update(auth, setting, { status: 'blocked', error: code, activeHostPid: null }); } catch {}
      }
    }
  }
  function tick() {
    if (closed || closing) return Promise.resolve();
    if (!currentTick) currentTick = runTick().finally(() => { currentTick = null; });
    return currentTick;
  }
  const timer = schedule(() => { void tick().catch(() => {}); }, 1000);
  void tick().catch(() => {});
  return {
    tick,
    async close() {
      if (closed) return;
      closing = true; unschedule(timer); await currentTick;
      for (const item of active.values()) await item.delivery.close();
      active.clear(); closed = true;
    }
  };
}
