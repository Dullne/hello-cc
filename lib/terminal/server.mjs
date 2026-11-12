import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { CliError } from '../shared/errors.mjs';

function authorized(req, token) {
  const supplied = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return !req.headers.origin && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new CliError('BAD_REQUEST', 'Terminal request exceeds 1 MiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new CliError('BAD_REQUEST', 'Invalid terminal request JSON'); }
}
const errorBody = error => ({ error: { code: error.code || 'TERMINAL_REQUEST_FAILED',
  message: error.message || 'Terminal request failed', ...(error.control ? { control: error.control } : {}) } });

export async function startTerminalServer({ host, token, identity, onShutdown = async () => {} }) {
  let stopping = false;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    if (!authorized(req, token)) return json(res, 401, errorBody(new CliError('UNAUTHORIZED', 'Terminal service authentication required')));
    if (req.headers['x-hcc-terminal-generation'] !== host.generation) return json(res, 409,
      errorBody(new CliError('TERMINAL_HOST_CHANGED', 'Terminal service instance changed')));
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/status') return json(res, 200,
        { protocol: 1, generation: host.generation, identity, stopping });
      if (stopping) throw new CliError('TERMINAL_HOST_STOPPING', 'Terminal service is stopping');
      if (req.method === 'GET' && url.pathname === '/sessions') return json(res, 200, { sessions: host.list() });
      if (req.method === 'POST' && url.pathname === '/sessions') return json(res, 201, await host.create(await body(req)));
      const match = /^\/sessions\/([a-zA-Z0-9_-]{1,128})\/(snapshot|forget)$/.exec(url.pathname);
      if (req.method === 'POST' && match) {
        const input = await body(req);
        if (match[2] === 'snapshot') return json(res, 200, await host.snapshot(match[1], input.generation));
        host.forget(match[1], input.generation); return json(res, 200, { removed: true });
      }
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        if (host.list().some(session => session.status !== 'exited')) throw new CliError('TERMINAL_HOST_BUSY', 'Close managed terminals before stopping their service');
        stopping = true; json(res, 200, { stopping: true });
        setImmediate(() => { void onShutdown().catch(() => {}); }); return;
      }
      json(res, 404, errorBody(new CliError('NOT_FOUND', 'Unknown terminal service route')));
    } catch (error) { if (!res.headersSent) json(res, error.code === 'BAD_REQUEST' ? 400 : 409, errorBody(error)); else res.destroy(); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  server.on('upgrade', (req, socket, head) => {
    if (!authorized(req, token) || req.headers['x-hcc-terminal-generation'] !== host.generation || stopping) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/attach') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    sockets.add(ws);
    let selected = null, attached = false, closed = false, chain = Promise.resolve();
    let queuedFrames = 0, queuedBytes = 0;
    function detachAccepted() {
      if (!selected || !attached) return;
      attached = false;
      try { host.detach(selected.id, selected.generation, selected.token); } catch {}
    }
    const deadline = setTimeout(() => ws.close(1008, 'Attach deadline'), 5000); deadline.unref();
    function send(frame) {
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1024 * 1024) {
        ws.close(1013, 'Reconnect for a fresh terminal screen'); throw new Error('Terminal viewer is unavailable');
      }
      ws.send(JSON.stringify(frame));
    }
    ws.on('message', raw => {
      if (closed) return;
      if (queuedFrames >= 32 || queuedBytes + raw.length > 256 * 1024) {
        closed = true; ws.close(1013, 'Too many pending terminal actions'); return;
      }
      queuedFrames += 1; queuedBytes += raw.length;
      chain = chain.then(async () => {
        if (closed) return;
        let message;
        try {
          message = JSON.parse(raw.toString());
          if (!message || typeof message !== 'object') throw new CliError('BAD_REQUEST', 'Invalid terminal message');
          if (!selected) {
            if (message.type !== 'attach' || typeof message.clientToken !== 'string') throw new CliError('BAD_REQUEST', 'Attach before terminal actions');
            // Remember a pending attach so a socket closed during the screen
            // barrier is detached again after the asynchronous attach resolves.
            selected = { id: message.id, generation: message.generation, token: message.clientToken };
            const control = await host.attach(selected.id, selected.generation, selected.token, send);
            attached = true;
            clearTimeout(deadline);
            if (closed) { detachAccepted(); return; }
            send({ type: 'attached', control, generation: selected.generation, hostGeneration: host.generation }); return;
          }
          if (message.generation !== selected.generation || message.hostGeneration !== host.generation) throw new CliError('TERMINAL_GENERATION_CHANGED', 'Terminal instance changed');
          if (typeof message.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(message.requestId)) throw new CliError('BAD_REQUEST', 'Terminal action needs a request identity');
          const result = message.type === 'terminate'
            ? await host.terminate(selected.id, selected.generation, selected.token, message.epoch)
            : host.action(selected.id, selected.generation, selected.token, message);
          send({ type: 'reply', requestId: message.requestId, result });
        } catch (error) {
          try { send({ type: 'error', requestId: message?.requestId, ...errorBody(error) }); } catch {}
          if (!message?.requestId) ws.close(1008, 'Terminal attach failed');
        }
      }).catch(() => ws.close(1011, 'Terminal connection failed'))
        .finally(() => { queuedFrames -= 1; queuedBytes -= raw.length; });
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      closed = true; clearTimeout(deadline); sockets.delete(ws);
      detachAccepted();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, async close() {
    stopping = true;
    for (const socket of sockets) socket.terminate();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => wss.close(resolve));
  }};
}
