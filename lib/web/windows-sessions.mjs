import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureTerminalHost } from '../terminal/client.mjs';
import { ensurePrivateProjectStateDir } from '../runtime/private-state.mjs';
import { captureSelectedCwdSnapshot, sameSelectedCwdIdentity } from '../process/selected-cwd-identity.mjs';
import { childSessionEnv, launchEnvironmentFingerprint } from '../core/sessions/launch.mjs';
import { buildPeerInvocation } from '../integrations/providers.mjs';
import { assertCodexTerminalLaunch, CODEX_SESSION_ORIGIN_ENV } from '../core/sessions/codex-thread-root.mjs';
import { CliError } from '../shared/errors.mjs';

export function createWindowsSessions({ ctx, sessions, sessionKey, connectWebProject, nextProjectSessionId, isStopping,
  cookieSocketValid, terminalHostFactory = ensureTerminalHost }) {
  let clientPromise;
  const client = () => clientPromise ||= terminalHostFactory().catch(error => { clientPromise = null; throw error; });
  async function listCurrent() {
    try { return await (await client()).list(); }
    catch (error) {
      if (!['TERMINAL_HOST_OFFLINE', 'TERMINAL_HOST_CHANGED'].includes(error.code)) throw error;
      clientPromise = null;
      // Only discovery is retried. The launcher must confirm the previous
      // process exit before starting a replacement; mutations stay uncertain.
      return (await client()).list();
    }
  }
  function adopt(row, projectCtx) {
    const key = sessionKey(projectCtx, row.id);
    let session = sessions.get(key);
    if (session && (session.type !== 'windows-terminal' || session.generation !== row.generation || session.hostGeneration !== row.hostGeneration)) {
      for (const connection of session.hostConnections?.values() || []) connection.close();
      for (const socket of session.clients || []) socket.close(1012, 'Terminal instance changed');
      session = null;
    }
    if (!session) {
      session = { type: 'windows-terminal', id: row.id, peerId: row.peerId, root: projectCtx.root, ctx: projectCtx,
        clients: new Set(), actionTokens: new Set(), actionTokenSockets: new Map(), hostConnections: new Map(), controls: new Map(), buffer: '' };
      sessions.set(key, session);
    }
    Object.assign(session, { kind: row.kind, role: row.role, cwd: row.cwd, pid: row.pid, status: row.status,
      createdAt: row.createdAt, exitedAt: row.exitedAt, command: row.binding?.command || row.command.file,
      binding: { ...row.binding, peer: row.peerId, transport: 'windows-terminal', runtime_session_id: row.id },
      generation: row.generation, hostGeneration: row.hostGeneration, terminalCapabilities: row.capabilities, hostRecord: row });
    return session;
  }
  async function discover(projectCtx = ctx) {
    const rows = await listCurrent();
    const identity = projectCtx.rootIdentity || projectCtx.initialRootIdentity || captureSelectedCwdSnapshot(projectCtx.root);
    const found = new Set();
    for (const row of rows) {
      if (row.project.root !== projectCtx.root || row.project.dbPath !== projectCtx.dbPath || !sameSelectedCwdIdentity(identity, row.project.rootIdentity)) continue;
      found.add(row.id); adopt(row, projectCtx);
    }
    for (const session of sessions.values()) if (session.type === 'windows-terminal' && session.root === projectCtx.root && !found.has(session.id)) {
      session.status = 'unknown';
      for (const connection of session.hostConnections.values()) connection.close();
    }
  }
  async function start(input) {
    if (isStopping()) throw new CliError('RUNTIME_STOPPING', 'Web runtime is stopping');
    const projectCtx = input.projectCtx || ctx;
    const kind = input.kind || 'shell', id = input.id || nextProjectSessionId(projectCtx, kind);
    const invocation = input.invocation || buildPeerInvocation(id, kind, {}, []);
    if (input.command && !input.invocation) throw new CliError('BAD_REQUEST', 'Windows terminal commands require an executable and literal argument list');
    const cwd = path.resolve(input.cwd || projectCtx.root);
    const cwdIdentity = input.cwdIdentity || captureSelectedCwdSnapshot(cwd);
    const rootIdentity = captureSelectedCwdSnapshot(projectCtx.root);
    let origin;
    const db = connectWebProject(projectCtx);
    try { origin = assertCodexTerminalLaunch(db, invocation.binding, { command: invocation.command,
      argv: [invocation.file, ...invocation.args], root: projectCtx.root, rootIdentity, cwd, cwdIdentity }); }
    finally { db.close(); }
    const env = childSessionEnv({ HCC_PEER: id, HCC_ROOT: projectCtx.root, HCC_DB: projectCtx.dbPath,
      TERM: 'xterm-256color', ...(origin ? { [CODEX_SESSION_ORIGIN_ENV]: origin } : {}) }, input.env || process.env, { rootIdentity });
    const service = await client();
    const previous = (await service.list()).find(row => row.project.root === projectCtx.root && row.project.dbPath === projectCtx.dbPath && row.peerId === id);
    if (previous) {
      if (previous.status === 'running' && sameSelectedCwdIdentity(previous.cwdIdentity, cwdIdentity) &&
          previous.command.file === invocation.file && JSON.stringify(previous.command.args) === JSON.stringify(invocation.args) &&
          previous.environmentFingerprint === launchEnvironmentFingerprint(env)) return adopt(previous, projectCtx);
      throw new CliError('PEER_RUNTIME_CONFLICT', 'This peer already has a terminal; attach or explicitly close it before creating another');
    }
    const row = await service.create({ id: `wt-${randomUUID()}`, peerId: id, kind, role: input.role || 'peer',
      project: { root: projectCtx.root, rootIdentity, stateDir: ensurePrivateProjectStateDir(projectCtx.root), dbPath: projectCtx.dbPath },
      cwd, cwdIdentity, command: { file: invocation.file, args: invocation.args }, binding: invocation.binding,
      env, cols: input.size?.cols || 100, rows: input.size?.rows || 30 });
    return adopt(row, projectCtx);
  }
  function status(session, token) { return session.controls.get(token) || { epoch: 0, has_controller: true, can_control: false }; }
  function assertControl(session, token, epoch) {
    const current = status(session, token);
    if (!session.hostConnections.has(token) || !current.can_control || current.epoch !== epoch) throw new CliError('CONTROL_REQUIRED', 'Connect and take terminal control before acting');
    return current;
  }
  async function action(session, token, message) {
    const connection = session.hostConnections.get(token);
    if (!connection) throw new CliError('UNKNOWN_CONTROL_CLIENT', 'Connect to this terminal before acting');
    const result = await connection.action(message);
    if (message.type === 'terminate') adopt(result, session.ctx);
    return result;
  }
  async function browser(session, ws, token) {
    let initial, attached = false, closed = false, pendingBytes = 0;
    const pending = [];
    const send = frame => {
      if (closed || !cookieSocketValid(ws) || ws.readyState !== 1 || ws.bufferedAmount > 1024 * 1024) {
        ws.close(1013, 'Reconnect for terminal screen'); throw new Error('Browser is unavailable');
      }
      ws.send(JSON.stringify(frame));
    };
    const forward = frame => {
      if (frame.type === 'data') send({ type: 'data', data: frame.data, sequence: frame.sequence });
      else if (frame.type === 'control') send({ type: 'control', control: frame.control });
      else if (frame.type === 'exit') { session.status = frame.session?.status || 'exited'; send({ type: 'exit', event: frame.event }); }
      else if (frame.type === 'disconnected') ws.close(1012, 'Terminal service disconnected');
    };
    const ready = (await client()).connect(session.id, session.generation, { clientToken: token, onFrame(frame) {
      if (frame.control) session.controls.set(token, frame.control);
      if (frame.type === 'snapshot') { initial = frame; return; }
      if (frame.type === 'attached') {
        send({ type: 'snapshot', data: initial.screen, action_token: token, control: frame.control,
          terminal_generation: session.generation, host_generation: session.hostGeneration });
        attached = true; for (const queued of pending) forward(queued); pending.length = 0; return;
      }
      if (!attached) { pendingBytes += Buffer.byteLength(JSON.stringify(frame));
        if (pendingBytes > 1024 * 1024) { ws.close(1013, 'Terminal reconnect required'); return; }
        pending.push(frame); return; }
      forward(frame);
    }});
    let queue = Promise.resolve(), admitted = 0;
    ws.on('message', raw => {
      if (++admitted > 32) { ws.close(1013, 'Too many pending terminal actions'); return; }
      queue = queue.then(async () => {
        const connection = await ready;
        if (closed || isStopping() || !cookieSocketValid(ws)) return;
        session.ctx.rootIdentity?.assertUnchanged();
        const message = JSON.parse(String(raw));
        if (message.action_token !== token) return;
        if (message.type === 'input') {
          await connection.action({ type: 'input', epoch: message.epoch, data: message.data });
          send({ type: 'input_ack', input_id: message.input_id || null });
        } else if (message.type === 'resize') await connection.action({ type: 'resize', epoch: message.epoch, cols: message.cols, rows: message.rows });
        else if (message.type === 'control' && ['claim', 'release'].includes(message.action)) {
          await connection.action({ type: message.action, epoch: message.epoch, takeover: message.force === true });
        }
      }).catch(error => { try { send({ type: 'error', error: { code: error.code || 'BAD_REQUEST', message: error.code ? error.message : 'Invalid terminal frame' }, control: status(session, token) }); } catch {} })
        .finally(() => { admitted -= 1; });
    });
    ws.on('close', () => {
      closed = true; session.clients.delete(ws); session.actionTokens.delete(token); session.actionTokenSockets.delete(token);
      session.controls.delete(token); session.hostConnections.get(token)?.close(); session.hostConnections.delete(token);
      void ready.then(connection => connection.close()).catch(() => {});
    });
    try {
      const connection = await ready;
      if (closed) connection.close(); else session.hostConnections.set(token, connection);
    } catch { ws.close(1011, 'Terminal connection failed'); }
  }
  function detachAll() { for (const session of sessions.values()) if (session.type === 'windows-terminal') for (const connection of session.hostConnections.values()) connection.close(); }
  return { start, discover, status, assertControl, action, browser, detachAll };
}
