import { randomUUID } from 'node:crypto';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { createControlLease } from '../web/control-lease.mjs';
import { CliError } from '../shared/errors.mjs';
import { launchEnvironmentFingerprint } from '../core/sessions/launch.mjs';

const { Terminal } = headless;
const { SerializeAddon } = serialize;
const MAX_INPUT = 65536;
const MAX_PENDING = 4 * 1024 * 1024;
const fail = (code, message) => new CliError(code, message);
export function terminalSize(cols, rows) {
  if (!Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 1 || rows > 200) {
    throw fail('BAD_REQUEST', 'Terminal size must be 2..500 columns and 1..200 rows');
  }
  return { cols, rows };
}

// The host alone owns PTYs, screen state and control epochs. A Web runtime or
// CLI client may disappear without changing process ownership.
export function createTerminalHost({ spawnPty, validateProject, prepareCreate = () => () => {}, publishCreated = () => {}, publishExited = () => {}, maxSessions = 32 } = {}) {
  const generation = randomUUID();
  const sessions = new Map();
  let stopping = false;
  const control = createControlLease({ broadcast(session) {
    for (const [token, send] of session.clients) deliver(session, token, send,
      { type: 'control', control: control.status(session, token) });
  }});

  function deliver(session, token, send, frame) {
    try { send({ ...frame, hostGeneration: generation, generation: session.generation, id: session.id }); }
    catch { session.clients.delete(token); control.disconnect(session, token); }
  }
  function broadcast(session, frame) {
    for (const [token, send] of session.clients) deliver(session, token, send, frame);
  }
  function selected(id, expectedGeneration) {
    const session = sessions.get(id);
    if (!session) throw fail('TERMINAL_NOT_FOUND', 'Managed terminal does not exist');
    if (session.generation !== expectedGeneration) throw fail('TERMINAL_GENERATION_CHANGED', 'Terminal instance changed; reconnect before acting');
    return session;
  }
  function describe(session) {
    return { id: session.id, generation: session.generation, hostGeneration: generation,
      project: session.input.project, peerId: session.input.peerId, kind: session.input.kind, role: session.input.role,
      binding: session.input.binding || null, command: session.input.command, cwd: session.input.cwd,
      cwdIdentity: session.input.cwdIdentity, pid: session.pty.pid, creationTime: session.pty.creationTime,
      processIdentity: session.processIdentity || null, environmentFingerprint: launchEnvironmentFingerprint(session.input.env),
      status: session.status, createdAt: session.createdAt, exitedAt: session.exitedAt, exit: session.exit,
      cols: session.terminal.cols, rows: session.terminal.rows,
      capabilities: { persistent: true, snapshot: true, input: true, resize: true, terminate: true } };
  }
  function enqueue(session, fn) {
    const result = session.tail.then(fn);
    session.tail = result.catch(error => { session.error = error.code || 'TERMINAL_STATE_ERROR'; });
    return result;
  }
  function screen(session) {
    return { type: 'snapshot', screen: session.serializer.serialize({ scrollback: 1000 }),
      sequence: session.sequence, session: describe(session) };
  }
  async function create(input) {
    if (stopping) throw fail('TERMINAL_HOST_STOPPING', 'Terminal service is stopping');
    if (!input || typeof input !== 'object' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id || '') ||
        !input.project || typeof input.cwd !== 'string' || !input.cwdIdentity ||
        typeof input.command?.file !== 'string' || !Array.isArray(input.command.args) ||
        input.command.args.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
        typeof input.env !== 'object' || input.env === null || Array.isArray(input.env)) {
      throw fail('BAD_REQUEST', 'A terminal requires an id, project identity, selected directory and literal command arguments');
    }
    if (sessions.has(input.id)) throw fail('TERMINAL_EXISTS', 'Terminal already exists; inspect its receipt before retrying');
    if (sessions.size >= maxSessions) {
      const retired = [...sessions.values()].find(session => session.status === 'exited' && session.clients.size === 0);
      if (retired) forget(retired.id, retired.generation);
    }
    if (sessions.size >= maxSessions) throw fail('TERMINAL_LIMIT', 'Terminal service session limit reached; remove an exited session');
    const size = terminalSize(input.cols ?? 100, input.rows ?? 30);
    validateProject(input.project, input.cwd, input.cwdIdentity);
    const release = prepareCreate(input);
    const terminal = new Terminal({ ...size, scrollback: 1000, allowProposedApi: true });
    const serializer = new SerializeAddon(); terminal.loadAddon(serializer);
    let pty;
    try { pty = spawnPty(input.command.file, input.command.args, { cwd: input.cwd, env: input.env,
      expectedIdentity: input.cwdIdentity, ...size }); }
    catch (error) { terminal.dispose(); release(); throw error; }
    if (!Number.isInteger(pty.pid) || pty.pid <= 0 || !pty.creationTime) {
      try { await pty.closeOwned(); } finally { terminal.dispose(); release(); }
      throw fail('TERMINAL_START_UNCONFIRMED', 'Terminal process identity was not confirmed');
    }
    const session = { id: input.id, input: structuredClone(input), generation: randomUUID(), terminal, serializer, pty,
      processIdentity: pty.processIdentity || null,
      status: 'running', createdAt: new Date().toISOString(), exitedAt: null, exit: null,
      sequence: 0, pendingBytes: 0, tail: Promise.resolve(), clients: new Map(), error: null, release };
    sessions.set(session.id, session);
    // Observe owned exit before publication: failed publication can itself need
    // a retriable close, and that retained session still needs its exit receipt.
    pty.onData(data => {
      const bytes = Buffer.byteLength(data);
      session.pendingBytes += bytes;
      if (session.pendingBytes > MAX_PENDING) {
        session.pendingBytes -= bytes;
        session.status = 'close_unconfirmed'; session.error = 'TERMINAL_OUTPUT_LIMIT';
        void pty.closeOwned().catch(() => {}); return;
      }
      if (session.pendingBytes > 1024 * 1024) pty.pause();
      void enqueue(session, async () => {
        await new Promise(resolve => terminal.write(data, resolve));
        session.sequence += 1;
        broadcast(session, { type: 'data', sequence: session.sequence, data });
        session.pendingBytes -= bytes;
        if (session.pendingBytes < 256 * 1024) pty.resume();
      });
    });
    pty.onExit(event => {
      void enqueue(session, () => {
        session.status = event?.unconfirmed || event?.uncertain ? 'close_unconfirmed' : 'exited';
        session.exit = event; session.exitedAt = new Date().toISOString();
        try { publishExited(describe(session)); }
        catch (error) { session.error = error.code || 'TERMINAL_STATE_UNCONFIRMED'; }
        if (session.status === 'exited') release();
        broadcast(session, { type: 'exit', event, session: describe(session) });
      });
    });
    try { session.processIdentity = publishCreated(describe(session)); }
    catch (error) {
      try {
        await pty.closeOwned(); await session.tail;
        if (session.status !== 'exited') throw fail('TERMINAL_CLOSE_UNCONFIRMED', 'Terminal exit receipt was not confirmed');
        sessions.delete(session.id); terminal.dispose();
      } catch (closeError) { session.status = 'close_unconfirmed'; throw closeError; }
      throw error;
    }
    return describe(session);
  }
  async function attach(id, expectedGeneration, token, send) {
    const session = selected(id, expectedGeneration);
    if (typeof token !== 'string' || !token || token.length > 256 || typeof send !== 'function') throw fail('BAD_REQUEST', 'Invalid terminal client');
    return enqueue(session, () => {
      // Register only after the screen barrier, so output cannot race ahead of
      // the initial snapshot or be replayed twice after it.
      if (session.clients.has(token)) throw fail('CONTROL_CLIENT_CONNECTED', 'Terminal client is already connected');
      send({ ...screen(session), id, generation: session.generation, hostGeneration: generation });
      session.clients.set(token, send);
      return control.connect(session, token);
    });
  }
  function detach(id, expectedGeneration, token) {
    const session = selected(id, expectedGeneration);
    session.clients.delete(token); return control.disconnect(session, token);
  }
  function action(id, expectedGeneration, token, message) {
    const session = selected(id, expectedGeneration);
    if (message.type === 'claim') return control.claim(session, token, message);
    if (message.type === 'release') return control.release(session, token, message.epoch);
    control.assertControl(session, token, message.epoch);
    if (session.status !== 'running') throw fail('TERMINAL_NOT_RUNNING', 'Terminal is not running');
    validateProject(session.input.project, session.input.cwd, session.input.cwdIdentity);
    if (message.type === 'input') {
      if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > MAX_INPUT) throw fail('BAD_REQUEST', 'Terminal input exceeds 64 KiB');
      session.pty.write(message.data);
    } else if (message.type === 'resize') {
      const size = terminalSize(message.cols, message.rows);
      session.pty.resize(size.cols, size.rows);
      // Screen resize follows all output already received from the old size.
      void enqueue(session, () => session.terminal.resize(size.cols, size.rows));
    } else throw fail('BAD_REQUEST', 'Unknown terminal action');
    return control.status(session, token);
  }
  async function terminate(id, expectedGeneration, token, epoch) {
    const session = selected(id, expectedGeneration);
    control.assertControl(session, token, epoch);
    if (session.status === 'exited') return describe(session);
    try { await session.pty.closeOwned({ timeoutMs: 10000 }); await session.tail; }
    catch (error) { session.status = 'close_unconfirmed'; broadcast(session, { type: 'state', session: describe(session) }); throw error; }
    if (session.status !== 'exited') throw fail('TERMINAL_CLOSE_UNCONFIRMED', 'Terminal exit receipt was not confirmed');
    return describe(session);
  }
  function forget(id, expectedGeneration) {
    const session = selected(id, expectedGeneration);
    if (session.status !== 'exited') throw fail('TERMINAL_NOT_EXITED', 'Confirm terminal exit before removing it');
    if (session.clients.size) throw fail('TERMINAL_ATTACHED', 'Detach terminal viewers before removing it');
    control.forget(session); session.terminal.dispose(); sessions.delete(id);
  }
  async function close() {
    stopping = true;
    const results = await Promise.allSettled([...sessions.values()].map(async session => {
      await session.pty.closeOwned({ timeoutMs: 10000 }); await session.tail;
      session.release(); control.forget(session); session.terminal.dispose();
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  return { generation, create, attach, detach, action, terminate, forget, close,
    list: () => [...sessions.values()].map(describe),
    snapshot: (id, expectedGeneration) => { const session = selected(id, expectedGeneration); return enqueue(session, () => screen(session)); },
    status: (id, expectedGeneration, token) => control.status(selected(id, expectedGeneration), token) };
}
