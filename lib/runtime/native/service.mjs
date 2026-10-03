import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CliError } from '../../shared/errors.mjs';
import { redactSecrets } from '../../shared/redact.mjs';
import { fileLockEndpoint } from '../../shared/file-lock.mjs';
import { shellQuoteArg } from '../../format.mjs';
import { commandPath } from '../../cli-runtime.mjs';
import { tx } from '../../db/schema.mjs';
import { createScopedMcpConfig } from '../../mcp/scope.mjs';
import { createNativeAdapter, nativeWorkerEnv, NATIVE_PROVIDERS } from '../../integrations/native/index.mjs';
import { createNativeStore, nativePaths, readNativePointer, writeNativePointer } from './store.mjs';

function publicError(error) {
  return redactSecrets({ code: error.code || 'NATIVE_REQUEST_FAILED', message: error.message || 'Native operation failed', extra: error.extra || {} });
}
function reply(response, status, result) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(result));
}
async function jsonBody(request) {
  request.setEncoding('utf8');
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (Buffer.byteLength(data) > 1024 * 1024) throw new CliError('BAD_ARGS', 'Native request body is too large');
  }
  try {
    const value = JSON.parse(data || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch { throw new CliError('BAD_ARGS', 'Native request body must be a JSON object'); }
}

// Business state stays in mesh.db; owned provider lifecycle and receipts have
// their own store. No desktop-private servers or foreign processes are used.
export async function startNativeService(ctx, deps, options = {}) {
  const paths = nativePaths(ctx, { create: true });
  const ownership = net.createServer((socket) => socket.end());
  const endpoint = fileLockEndpoint(path.join(paths.dir, 'service-owner'));
  await new Promise((resolve, reject) => {
    ownership.once('error', () => reject(new CliError('NATIVE_RUNTIME_IN_USE', 'A native runtime already owns this project, or its ownership port is unavailable.')));
    ownership.listen(endpoint.port, '127.0.0.1', resolve);
  });
  let store;
  let mesh;
  try {
    store = createNativeStore(ctx);
    mesh = deps.connect(ctx, { migrateRegistered: false });
    store.disconnected();
  } catch (error) { ownership.close(); store?.close(); mesh?.close(); throw error; }
  const workers = new Map();
  const creating = new Set();
  const operations = new Set();
  const generation = randomUUID();
  const token = randomBytes(32).toString('hex');
  let stopping = false;
  let storeClosed = false;
  let shutdownPromise;
  let shutdownError = null;
  let pollTimer;
  const adapterFactory = options.adapterFactory || createNativeAdapter;
  const identity = deps.liveProcessIdentity(process.pid);

  function track(promise) {
    operations.add(promise);
    void promise.finally(() => operations.delete(promise)).catch(() => {});
    return promise;
  }
  function requireRunning() {
    if (stopping) throw new CliError('NATIVE_RUNTIME_STOPPING', 'Native runtime is stopping');
  }
  function assertOwner(worker) {
    const binding = mesh.prepare('SELECT * FROM peer_bindings WHERE peer=?').get(worker.peer);
    if (!binding || binding.transport !== 'native' || binding.runtime_target !== worker.owner || binding.provider !== worker.provider) {
      throw new CliError('NATIVE_PEER_IN_USE', 'Peer ownership changed; its current binding has been preserved');
    }
  }
  function assertRequestedOwner(worker, input = {}) {
    assertOwner(worker);
    const snapshot = worker.adapter?.snapshot();
    if ((input.generation !== undefined && input.generation !== generation) ||
        (input.owner !== undefined && input.owner !== worker.owner) ||
        (input.provider !== undefined && input.provider !== worker.provider) ||
        (input.sessionId !== undefined && input.sessionId !== (snapshot?.sessionId || null))) {
      throw new CliError('NATIVE_OWNER_CHANGED', 'Native worker identity changed; refresh its current state before controlling it');
    }
  }
  function save(worker) {
    if (!worker.adapter || storeClosed) return;
    const snapshot = worker.adapter.snapshot();
    tx(mesh, () => {
      assertOwner(worker);
      if (snapshot.sessionId && mesh.prepare('SELECT peer FROM peer_bindings WHERE provider=? AND (provider_session_id=? OR provider_session_name=?) AND peer<>?')
        .get(worker.provider, snapshot.sessionId, snapshot.sessionId, worker.peer)) {
        throw new CliError('PROVIDER_SESSION_IN_USE', 'Native session became bound to another peer; that binding has been preserved');
      }
      const exited = ['closed', 'disconnected', 'exited', 'stopped'].includes(snapshot.status);
      const status = exited ? 'exited' : worker.quarantined || ['error', 'uncertain', 'failed'].includes(snapshot.status) ? 'blocked'
        : worker.active || ['busy', 'running', 'queued', 'opening', 'closing', 'interrupting'].includes(snapshot.status) ? 'working' : 'idle';
      deps.upsertCanonicalPeerBinding(mesh, { peer: worker.peer, provider: worker.provider,
        provider_session_id: snapshot.sessionId || null, provider_session_name: null,
        resume_mode: snapshot.sessionId ? 'resume' : 'new', resume_arg: snapshot.sessionId || null,
        command: null, transport: 'native', runtime_session_id: worker.peer, runtime_target: worker.owner });
      deps.upsertPeer(mesh, { id: worker.peer, kind: worker.provider, role: 'native-worker', worktree: worker.cwd,
        branch: worker.branch, pid: exited ? null : process.pid, processIdentity: exited ? null : identity,
        status, capabilities: JSON.stringify(snapshot.capabilities || worker.adapter.capabilities) });
    });
    store.saveWorker({ peer: worker.peer, provider: worker.provider, cwd: worker.cwd, ...snapshot });
  }
  function belongs(event, active) {
    if (!active) return false;
    if (event.submissionId && event.submissionId !== active.delivery.submission_id) return false;
    if (event.turnId && active.turnId && event.turnId !== active.turnId) return false;
    return event.submissionId === active.delivery.submission_id || Boolean(event.turnId && event.turnId === active.turnId);
  }
  function record(worker, event) {
    if (storeClosed || worker.closing) return;
    try {
      assertOwner(worker);
      const safe = redactSecrets(event);
      if (event.type !== 'delta' && event.type !== 'output') store.event(worker.peer, safe);
      const active = worker.active;
      const associated = belongs(event, active);
      if (associated && event.turnId) active.turnId = event.turnId;
      if (event.type === 'message' && associated && typeof event.text === 'string') worker.output.push(event.text);
      if (associated && ['message', 'delta', 'output'].includes(event.type)) {
        store.updateDelivery(active.delivery.id, 'accepted', active.turnId, { evidence: 'provider_output_observed' });
      }
      if (event.type === 'completed' && associated) {
        const completed = event.status === 'completed';
        // Reply and ACK commit together. A persistence failure cannot claim
        // completion or put a potentially consumed prompt back in the queue.
        tx(mesh, () => {
          assertOwner(worker);
          if (completed) {
            const text = worker.output.join('\n\n') || event.text;
            // A reply is delivered for context, but must not create another
            // automatic reply and an unbounded loop between native workers.
            if (text && active.message.kind !== 'reply') deps.sendMessage(mesh, worker.peer, active.message.sender, active.message.task_id, 'reply', text,
              { reply_to: active.message.id, thread_id: active.message.thread_id || active.message.id });
            deps.ackMessage(mesh, worker.peer, active.message);
          }
          deps.addEvent(mesh, `native.delivery.${completed ? 'completed' : 'failed'}`, worker.peer, active.message.task_id,
            { message_id: active.message.id, submission_id: active.delivery.submission_id, turn_id: event.turnId || active.turnId });
        });
        store.updateDelivery(active.delivery.id, completed ? 'completed' : 'failed', event.turnId || active.turnId,
          { status: event.status, error: event.error || null });
        worker.active = null;
        worker.output = [];
      }
      if (event.type === 'error' && active && (associated || (!event.turnId && !event.submissionId))) {
        store.updateDelivery(active.delivery.id, 'uncertain', active.turnId, safe);
        worker.active = null;
        worker.output = [];
        worker.quarantined = true;
      }
      save(worker);
    } catch (error) {
      worker.quarantined = true;
      console.error(JSON.stringify(publicError(error)));
      void closeWorker(worker.peer).catch((closeError) => console.error(JSON.stringify(publicError(closeError))));
    }
  }
  function ingest(worker, initial = false) {
    const messages = initial ? deps.queryInbox(mesh, worker.peer, false, 1_000_000)
      : mesh.prepare(`SELECT * FROM messages WHERE id>? AND sender<>? AND
          (recipient IS NULL OR recipient='' OR recipient='all' OR recipient=?) ORDER BY id LIMIT 1000`)
        .all(worker.lastMessageId, worker.peer, worker.peer);
    for (const message of messages) {
      if (message.sender !== worker.peer) store.queue(worker.peer, message.id, randomUUID());
      if (!initial) worker.lastMessageId = message.id;
    }
  }
  function createWorker(input) {
    const operation = createWorkerNow(input);
    const worker = workers.get(input.peer);
    if (worker) worker.creation = operation;
    return track(operation);
  }
  async function createWorkerNow(input) {
    requireRunning();
    const peer = typeof input.peer === 'string' ? input.peer : '';
    const provider = input.provider;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(peer) || peer === 'all' || !NATIVE_PROVIDERS.includes(provider)) {
      throw new CliError('BAD_ARGS', 'Use a valid peer name and provider codex, claude, or dsh');
    }
    for (const key of ['binary', 'model', 'resume']) {
      if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim())) {
        throw new CliError('BAD_ARGS', `Worker ${key} must be a nonempty string`);
      }
    }
    if (provider === 'claude' && input.binary !== undefined) throw new CliError('BAD_ARGS', 'Claude workers use the Agent SDK; --binary is available for Codex and dsh');
    if (workers.has(peer) || creating.has(peer)) throw new CliError('NATIVE_WORKER_EXISTS', `Native worker is already open: ${peer}`);
    const previous = store.worker(peer);
    let sessionId;
    if (input.resume) {
      if (!previous || previous.provider !== provider || !previous.session_id ||
          (input.resume !== 'last' && input.resume !== previous.session_id)) {
        throw new CliError('NATIVE_SESSION_NOT_OWNED', 'Only a session previously created by this native runtime can be resumed');
      }
      sessionId = previous.session_id;
    } else if (previous?.session_id) throw new CliError('NATIVE_RESUME_REQUIRED', 'This peer has a saved session. Use --resume last or choose a new peer name.');
    if (previous && previous.provider !== provider) throw new CliError('NATIVE_SESSION_NOT_OWNED', 'Peer belongs to a different native provider');
    if (input.cwd !== undefined && typeof input.cwd !== 'string') throw new CliError('BAD_ARGS', 'Worker cwd must be a directory');
    const cwd = fs.realpathSync(input.cwd || ctx.root);
    if (!fs.statSync(cwd).isDirectory()) throw new CliError('BAD_ARGS', 'Worker cwd must be a directory');
    const worker = { peer, provider, cwd, branch: deps.detectBranch(cwd), owner: `native:${generation}:${peer}:${randomUUID()}`,
      active: null, output: [], quarantined: false, closing: false, dispatch: null, closePromise: null };
    // Reserve identity before starting the child so installed hooks can only
    // heartbeat this exact worker. Every subsequent write checks this owner.
    tx(mesh, () => {
      const binding = mesh.prepare('SELECT * FROM peer_bindings WHERE peer=?').get(peer);
      const existing = mesh.prepare('SELECT * FROM peers WHERE id=?').get(peer);
      if ((binding && (binding.transport !== 'native' || binding.provider !== provider || !previous)) || (existing && !binding)) {
        throw new CliError('NATIVE_PEER_IN_USE', 'Peer is already owned by another transport');
      }
      if (sessionId && mesh.prepare('SELECT peer FROM peer_bindings WHERE provider=? AND (provider_session_id=? OR provider_session_name=?) AND peer<>?').get(provider, sessionId, sessionId, peer)) {
        throw new CliError('PROVIDER_SESSION_IN_USE', 'The saved native session is bound to another peer');
      }
      deps.upsertPeer(mesh, { id: peer, kind: provider, role: 'native-worker', worktree: cwd, branch: worker.branch,
        pid: process.pid, processIdentity: identity, status: 'working', capabilities: '' });
      deps.upsertCanonicalPeerBinding(mesh, { peer, provider, provider_session_id: sessionId || null,
        provider_session_name: null, resume_mode: sessionId ? 'resume' : 'new', resume_arg: sessionId || null,
        command: null, transport: 'native', runtime_session_id: peer, runtime_target: worker.owner });
      assertOwner(worker);
      worker.lastMessageId = mesh.prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages').get().id;
      ingest(worker, true);
    });
    store.saveWorker({ peer, provider, cwd, sessionId, status: 'opening' });
    creating.add(peer);
    workers.set(peer, worker);
    try {
      worker.mcpCapability = (options.mcpConfigFactory || createScopedMcpConfig)({ root: ctx.root, dbPath: ctx.dbPath,
        peer, executorId: worker.owner, ownerIdentity: identity,
        binding: { transport: 'native', runtimeSessionId: peer, runtimeTarget: worker.owner } });
      worker.adapter = await adapterFactory(provider, { binary: input.binary || undefined, cwd,
        executorId: worker.owner, interactive: true, mcpServers: { hello_cc_scoped: worker.mcpCapability.config },
        env: nativeWorkerEnv(process.env, ctx, peer, worker.owner), onEvent: (event) => {
          if (worker.adapter) record(worker, event);
        } });
      requireRunning();
      if (worker.closing) throw new CliError('NATIVE_WORKER_CLOSING', 'Worker was closed while opening');
      assertOwner(worker);
      await worker.adapter.open({ sessionId, model: input.model || undefined });
      requireRunning();
      save(worker);
      deps.addEvent(mesh, 'native.worker.opened', peer, null, { provider, session_id: worker.adapter.snapshot().sessionId || null, resumed: Boolean(sessionId) });
      return { peer, ...worker.adapter.snapshot() };
    } catch (error) {
      worker.closing = true;
      worker.mcpCapability?.dispose();
      let cleanupError;
      try { await worker.adapter?.close(); } catch (closeError) {
        cleanupError = closeError;
        worker.quarantined = true;
        console.error(JSON.stringify(publicError(closeError)));
      }
      if (!cleanupError) workers.delete(peer);
      try {
        if (worker.adapter) save(worker);
        else tx(mesh, () => { assertOwner(worker); mesh.prepare("UPDATE peers SET status='blocked' WHERE id=?").run(peer); });
      } catch {}
      store.saveWorker({ peer, provider, cwd, ...(worker.adapter?.snapshot() || {}), status: 'error' });
      if (cleanupError) throw new CliError('NATIVE_CLOSE_FAILED', 'Worker initialization failed and its owned provider exit was not confirmed',
        { uncertain: true, initialization: publicError(error), cleanup: publicError(cleanupError) });
      throw error;
    } finally { creating.delete(peer); }
  }
  function context(worker, message) {
    const command = ['env', `HCC_PEER=${worker.peer}`, `HCC_ROOT=${ctx.root}`, `HCC_DB=${ctx.dbPath}`,
      process.execPath, commandPath()].map(shellQuoteArg).join(' ');
    const tasks = mesh.prepare("SELECT id,status,owner,title FROM tasks WHERE status NOT IN ('done','abandoned') ORDER BY id DESC LIMIT 8").all();
    const locks = mesh.prepare('SELECT resource,owner,task_id FROM locks WHERE expires_at>? ORDER BY resource LIMIT 8').all(Math.floor(Date.now() / 1000));
    return ['[hello-cc native coordination]', `peer: ${worker.peer}`, `project: ${ctx.root}`,
      'Use the scoped hello_cc_scoped MCP tools for HCC state, tasks, locks, results and handoffs. Continue your owned task until done, blocked or handed off.',
      `Use this exact prefix for HCC commands: ${command}`,
      'Only the message below is being delivered in this turn. Do not independently consume or acknowledge other inbox messages.',
      message.kind === 'reply'
        ? 'This message is a reply. Use it to continue your work; do not send another acknowledgement reply. Final output remains in provider events.'
        : 'Your final response will be saved automatically as a reply to this message; no separate reply command is needed.',
      '[open tasks]', ...tasks.map((row) => JSON.stringify(row)), '[active locks]', ...locks.map((row) => JSON.stringify(row))].join('\n');
  }
  async function dispatch(worker, delivery, message) {
    try {
      const receipt = await worker.adapter.send({ text: `${context(worker, message)}\n\nMessage #${message.id} (${message.kind}) from ${message.sender}:\n${message.body}`,
        submissionId: delivery.submission_id });
      if (worker.active?.delivery.id === delivery.id) {
        worker.active.turnId = receipt.turnId || worker.active.turnId;
        const current = store.delivery(worker.peer, message.id);
        const state = receipt.status === 'accepted' || current.state === 'accepted' ? 'accepted' : 'submitted';
        store.updateDelivery(delivery.id, state, worker.active.turnId, { receipt_status: receipt.status });
      }
    } catch (error) {
      if (!storeClosed) {
        const current = store.delivery(worker.peer, message.id);
        if (current && !['completed', 'failed'].includes(current.state)) {
          store.updateDelivery(delivery.id, error.extra?.uncertain || current.state === 'uncertain' ? 'uncertain' : 'failed', null, publicError(error));
        }
      }
      if (worker.active?.delivery.id === delivery.id) { worker.active = null; worker.output = []; }
      worker.quarantined = true;
    }
    if (!worker.closing) { try { save(worker); } catch (error) { record(worker, { type: 'error', ...publicError(error) }); } }
  }
  async function poll() {
    if (stopping) return;
    for (const worker of workers.values()) {
      try {
        if (worker.closing || creating.has(worker.peer)) continue;
        save(worker);
        ingest(worker);
        if (worker.active || worker.dispatch || worker.quarantined) continue;
        if (!['idle', 'ready', 'completed'].includes(worker.adapter.snapshot().status)) continue;
        const delivery = store.pending(worker.peer);
        if (!delivery) continue;
        const message = mesh.prepare('SELECT * FROM messages WHERE id=?').get(delivery.message_id);
        if (!message) { store.updateDelivery(delivery.id, 'failed', null, { reason: 'source_message_missing' }); continue; }
        store.updateDelivery(delivery.id, 'dispatching');
        worker.active = { message, delivery, turnId: null };
        worker.output = [];
        const operation = dispatch(worker, delivery, message);
        worker.dispatch = operation;
        void track(operation).finally(() => { worker.dispatch = null; }).catch(() => {});
      } catch (error) { record(worker, { type: 'error', ...publicError(error) }); }
    }
  }
  function closeWorker(peer) {
    const worker = workers.get(peer);
    if (!worker) return Promise.reject(new CliError('NATIVE_WORKER_NOT_FOUND', `Native worker is not open: ${peer}`));
    if (worker.closePromise) return worker.closePromise;
    worker.closing = true;
    worker.mcpCapability?.dispose();
    if (worker.active && !storeClosed) {
      store.updateDelivery(worker.active.delivery.id, 'uncertain', worker.active.turnId, { reason: 'worker_closed' });
      worker.active = null;
    }
    const closing = (async () => {
      // A pending factory detects closing and disposes its late child itself.
      const adapterAtClose = worker.adapter;
      await adapterAtClose?.close();
      if (worker.creation) await worker.creation.catch(() => {});
      // Factories can resolve after close begins. Confirm their cleanup even
      // when initialization itself rejected; its cleanup may also have failed.
      if (worker.adapter && worker.adapter !== adapterAtClose) await worker.adapter.close();
      try { save(worker); } catch (error) { if (error.code !== 'NATIVE_PEER_IN_USE') throw error; }
      if (!creating.has(peer)) workers.delete(peer);
      return { peer, status: 'closed' };
    })();
    worker.closePromise = track(closing);
    void closing.catch((error) => {
      worker.quarantined = true;
      worker.closePromise = null;
      if (!storeClosed) store.saveWorker({ peer: worker.peer, provider: worker.provider, cwd: worker.cwd,
        ...worker.adapter?.snapshot(), status: 'uncertain' });
      console.error(JSON.stringify(publicError(error)));
    });
    return worker.closePromise;
  }
  async function route(request, response) {
    if (request.headers.origin) return reply(response, 403, { ok: false, error: { code: 'NATIVE_ORIGIN_REFUSED', message: 'Native control is a local authenticated API' } });
    const provided = Buffer.from(String(request.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${token}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return reply(response, 401, { ok: false, error: { code: 'NATIVE_UNAUTHORIZED', message: 'Invalid native runtime credential' } });
    }
    try {
      const url = new URL(request.url, 'http://localhost');
      let result;
      if (request.method === 'POST' && !['/down', '/close'].includes(url.pathname)) requireRunning();
      if (request.method === 'GET' && url.pathname === '/status') {
        result = { generation, root: fs.realpathSync(ctx.root), meshDb: path.resolve(ctx.dbPath), pid: process.pid, stopping, shutdown_error: shutdownError,
          workers: store.workers().map((row) => ({ ...row, owned: workers.has(row.peer),
          owner: workers.get(row.peer)?.owner || null,
          ...(workers.has(row.peer) && workers.get(row.peer).adapter ? { capabilities: workers.get(row.peer).adapter.snapshot().capabilities,
            quarantined: workers.get(row.peer).quarantined } : {}) })) };
      } else if (request.method === 'GET' && /^\/workers\/[^/]+\/state$/.test(url.pathname)) {
        const peer = decodeURIComponent(url.pathname.split('/')[2]);
        const after = Number(url.searchParams.get('after') || 0);
        if (!Number.isSafeInteger(after) || after < 0) throw new CliError('BAD_ARGS', 'Event cursor must be a nonnegative integer');
        const worker = workers.get(peer);
        if (!worker?.adapter) throw new CliError('NATIVE_WORKER_NOT_FOUND', 'Target native worker is not open');
        assertRequestedOwner(worker, {
          ...(url.searchParams.has('generation') ? { generation: url.searchParams.get('generation') } : {}),
          ...(url.searchParams.has('owner') ? { owner: url.searchParams.get('owner') } : {})
        });
        const snapshot = worker.adapter.snapshot();
        result = { root: fs.realpathSync(ctx.root), meshDb: path.resolve(ctx.dbPath), generation,
          peer, provider: worker.provider, owner: worker.owner, cwd: worker.cwd, snapshot,
          quarantined: worker.quarantined, closing: worker.closing,
          active_delivery: worker.active ? { message_id: worker.active.message.id,
            submission_id: worker.active.delivery.submission_id, turn_id: worker.active.turnId } : null,
          events: store.events(peer, after), deliveries: store.deliveries(peer) };
      } else if (request.method === 'GET' && url.pathname === '/deliveries') result = store.deliveries(url.searchParams.get('peer'));
      else if (request.method === 'GET' && url.pathname === '/events') {
        const after = Number(url.searchParams.get('after') || 0);
        if (!Number.isSafeInteger(after) || after < 0) throw new CliError('BAD_ARGS', 'Event cursor must be a nonnegative integer');
        result = store.events(url.searchParams.get('peer') || '', after);
      } else if (request.method === 'POST' && url.pathname === '/workers') {
        const input = await jsonBody(request);
        requireRunning();
        result = await createWorker(input);
      } else if (request.method === 'POST' && url.pathname === '/send') {
        const input = await jsonBody(request);
        requireRunning();
        const worker = workers.get(input.peer);
        if (!worker || worker.closing || creating.has(input.peer)) throw new CliError('NATIVE_WORKER_NOT_FOUND', 'Target native worker is not open');
        if (worker.quarantined) throw new CliError('NATIVE_WORKER_UNCERTAIN', 'Worker needs inspection and an explicit close/resume before more submissions');
        if (typeof input.body !== 'string' || !input.body.trim() || typeof input.from !== 'string' || !input.from.trim() ||
            (input.taskId != null && (!Number.isSafeInteger(input.taskId) || input.taskId < 1))) throw new CliError('BAD_ARGS', 'Message needs a sender, nonempty body, and valid task ID');
        assertRequestedOwner(worker, input);
        if (input.submissionId !== undefined && (typeof input.submissionId !== 'string' ||
            !/^[A-Za-z0-9_-]{8,100}$/.test(input.submissionId))) {
          throw new CliError('BAD_ARGS', 'Submission ID must contain 8 to 100 letters, digits, underscores, or hyphens');
        }
        if (input.submissionId) {
          const previous = store.db.prepare('SELECT * FROM deliveries WHERE submission_id=?').get(input.submissionId);
          if (previous) {
            const message = mesh.prepare('SELECT * FROM messages WHERE id=?').get(previous.message_id);
            if (previous.peer !== input.peer || !message || message.sender !== input.from ||
                message.recipient !== input.peer || message.body !== input.body ||
                (message.task_id || null) !== (input.taskId || null)) {
              throw new CliError('NATIVE_SUBMISSION_MISMATCH', 'Submission ID is already used by a different message');
            }
            reply(response, 200, { ok: true, data: { message_id: previous.message_id,
              submission_id: previous.submission_id, state: previous.state } });
            return;
          }
        }
        const messageId = deps.sendMessage(mesh, input.from, input.peer, input.taskId || null, 'ask', input.body);
        const delivery = store.queue(input.peer, messageId, input.submissionId || randomUUID());
        result = { message_id: messageId, submission_id: delivery.submission_id, state: delivery.state };
      } else if (request.method === 'POST' && url.pathname === '/interrupt') {
        const input = await jsonBody(request);
        requireRunning();
        const worker = workers.get(input.peer);
        if (!worker?.adapter || worker.closing) throw new CliError('NATIVE_WORKER_NOT_FOUND', 'Target native worker is not open');
        assertRequestedOwner(worker, input);
        if (!worker.adapter.capabilities.interrupt) throw new CliError('NATIVE_CAPABILITY_UNSUPPORTED', 'Provider does not support interrupt');
        result = await track(worker.adapter.interrupt({ turnId: input.turnId || undefined }));
      } else if (request.method === 'POST' && url.pathname === '/respond') {
        const input = await jsonBody(request);
        requireRunning();
        const worker = workers.get(input.peer);
        if (!worker?.adapter || worker.closing || creating.has(input.peer)) throw new CliError('NATIVE_WORKER_NOT_FOUND', 'Target native worker is not open');
        assertRequestedOwner(worker, input);
        if (input.executorId !== worker.owner || !worker.adapter.capabilities.approvals || !worker.adapter.respond) {
          throw new CliError('NATIVE_APPROVAL_MISMATCH', 'Interaction belongs to another executor or provider has no responder');
        }
        result = await track(Promise.resolve(worker.adapter.respond(input)));
        save(worker);
      } else if (request.method === 'POST' && url.pathname === '/close') {
        const input = await jsonBody(request);
        if (input.owner !== undefined || input.generation !== undefined || input.provider !== undefined || input.sessionId !== undefined) {
          const worker = workers.get(input.peer);
          if (!worker) throw new CliError('NATIVE_WORKER_NOT_FOUND', 'Target native worker is not open');
          assertRequestedOwner(worker, input);
        }
        result = await closeWorker(input.peer);
      } else if (request.method === 'POST' && url.pathname === '/down') {
        reply(response, 200, { ok: true, data: { stopping: true } });
        void shutdown().catch((error) => console.error(JSON.stringify(publicError(error))));
        return;
      } else throw new CliError('NOT_FOUND', 'Unknown native control route');
      reply(response, 200, { ok: true, data: redactSecrets(result) });
    } catch (error) { reply(response, error.code === 'BAD_ARGS' ? 400 : 409, { ok: false, error: publicError(error) }); }
  }
  const server = http.createServer((request, response) => { void route(request, response); });
  server.requestTimeout = 40000;
  server.headersTimeout = 10000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    writeNativePointer(ctx, { root: fs.realpathSync(ctx.root), meshDb: path.resolve(ctx.dbPath), pid: process.pid,
      port: server.address().port, token, generation });
  } catch (error) { server.close(); ownership.close(); mesh.close(); store.close(); throw error; }
  pollTimer = setInterval(() => void poll(), options.pollMs || 300);
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    clearInterval(pollTimer);
    shutdownPromise = (async () => {
      const closing = await Promise.allSettled([...workers.keys()].map(closeWorker));
      // Settle creates and admissions before closing persistence.
      while (operations.size) await Promise.allSettled([...operations]);
      const remaining = await Promise.allSettled([...workers.keys()].map(closeWorker));
      const failures = [...closing, ...remaining].filter((result) => result.status === 'rejected');
      if (failures.length) {
        shutdownError = publicError(failures[0].reason);
        // Keep the control endpoint and ownership lock while a child may still
        // be alive. A new daemon must not silently take over these sessions.
        throw new CliError('NATIVE_SHUTDOWN_INCOMPLETE', 'Owned provider shutdown was not confirmed; runtime ownership is retained', shutdownError);
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => ownership.close(resolve));
      if (readNativePointer(ctx)?.generation === generation) fs.rmSync(paths.pointer, { force: true });
      storeClosed = true;
      mesh.close();
      store.close();
      options.onShutdown?.();
    })();
    const pendingShutdown = shutdownPromise;
    void pendingShutdown.catch(() => {
      if (shutdownPromise === pendingShutdown) shutdownPromise = null;
    });
    return shutdownPromise;
  }
  return { shutdown, port: server.address().port, generation, poll };
}
