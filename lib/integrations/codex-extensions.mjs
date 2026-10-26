// Opt-in, in-process host extensions for an owned App Server. No callbacks,
// arguments, credentials or results are exposed through HCC state/events.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const failure = (code, message) => Object.assign(new Error(message), { code });
const toolFailure = () => ({ success: false, contentItems: [{ type: 'inputText', text: 'The host tool is unavailable or its result could not be confirmed. Do not retry automatically.' }] });

function jsonCopy(value) {
  const text = JSON.stringify(value, (_key, entry) => {
    if (typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint' ||
        (typeof entry === 'number' && !Number.isFinite(entry))) throw new TypeError('Invalid JSON');
    return entry;
  });
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) throw new TypeError('JSON limit');
  return JSON.parse(text);
}

export function createCodexExtensions({ dynamicTools = [], refreshAuthTokens,
  executorId, isActive, isAvailable, assertDirectory = () => {}, timeoutMs = 30000 } = {}) {
  if (!Array.isArray(dynamicTools) || dynamicTools.length > 64 ||
      (refreshAuthTokens !== undefined && typeof refreshAuthTokens !== 'function') ||
      !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw failure('BAD_ARGS', 'Invalid Codex host extension configuration');
  }
  const tools = new Map();
  for (const entry of dynamicTools) {
    if (!object(entry) || !name(entry.name) ||
        (entry.namespace !== undefined && !name(entry.namespace)) ||
        typeof entry.description !== 'string' || !entry.description.trim() || entry.description.length > 8192 ||
        !object(entry.inputSchema) || entry.inputSchema.type !== 'object' ||
        typeof entry.handler !== 'function' || typeof entry.readOnly !== 'boolean') {
      throw failure('BAD_ARGS', 'Dynamic tools require a name, description, object schema, handler and explicit readOnly policy');
    }
    const key = JSON.stringify([entry.namespace ?? null, entry.name]);
    if (tools.has(key)) throw failure('BAD_ARGS', 'Duplicate Codex dynamic tool');
    let inputSchema;
    try { inputSchema = jsonCopy(entry.inputSchema); }
    catch { throw failure('BAD_ARGS', 'Dynamic tool schema must be bounded JSON'); }
    tools.set(key, { ...entry, inputSchema });
  }
  for (const entry of tools.values()) {
    if (entry.namespace && tools.has(JSON.stringify([null, entry.namespace]))) {
      throw failure('BAD_ARGS', 'A dynamic namespace cannot shadow a tool name');
    }
  }
  let closed = false;
  let authInFlight = null;
  let authAccount = null;
  const calls = new Map();
  const pending = new Map();
  const authRequests = new Set();
  const policies = new Map();
  const revokedTurns = new Set();

  async function bounded(callback, turnId = null) {
    const controller = new globalThis.AbortController();
    const key = Symbol();
    let timer;
    const stopped = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(failure('CODEX_EXTENSION_UNAVAILABLE', 'Codex host extension is no longer available')), { once: true });
      timer = setTimeout(() => controller.abort(), timeoutMs);
    });
    pending.set(key, { controller, turnId });
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (closed || controller.signal.aborted) throw failure('CODEX_EXTENSION_UNAVAILABLE', 'Codex host extension is no longer available');
        return callback(controller.signal);
      }), stopped]);
    } finally {
      clearTimeout(timer); pending.delete(key); controller.abort();
    }
  }

  function startParams(sandbox) {
    const functions = [], namespaces = new Map();
    for (const entry of tools.values()) {
      if (sandbox === 'read-only' && !entry.readOnly) continue;
      const spec = { name: entry.name, description: entry.description, inputSchema: structuredClone(entry.inputSchema) };
      if (!entry.namespace) functions.push({ type: 'function', ...spec });
      else {
        if (!namespaces.has(entry.namespace)) namespaces.set(entry.namespace, { type: 'namespace', name: entry.namespace,
          description: `Host tools in ${entry.namespace}`, tools: [] });
        namespaces.get(entry.namespace).tools.push(spec);
      }
    }
    const specs = [...functions, ...namespaces.values()];
    return dynamicTools.length ? { dynamicTools: specs } : {};
  }

  function active(params) {
    if (closed || !policies.has(params.threadId) || revokedTurns.has(params.turnId) || !isActive(params.threadId, params.turnId)) return false;
    assertDirectory();
    return true;
  }

  function toolCall(params, requestId) {
    const sandbox = policies.get(params.threadId);
    const entry = tools.get(JSON.stringify([params.namespace ?? null, params.tool]));
    if (!entry || !name(params.tool) || typeof params.callId !== 'string' || !params.callId || params.callId.length > 512 ||
        (sandbox === 'read-only' && !entry.readOnly)) return Promise.resolve(toolFailure());
    let args, fingerprint;
    try { if (!active(params)) return Promise.resolve(toolFailure()); args = jsonCopy(params.arguments);
      if (!object(args)) return Promise.resolve(toolFailure());
      fingerprint = JSON.stringify([params.threadId, params.turnId, params.namespace ?? null, params.tool, args]);
    } catch { return Promise.resolve(toolFailure()); }
    const key = JSON.stringify([params.threadId, params.callId]);
    const previous = calls.get(key);
    if (previous) return previous.fingerprint === fingerprint ? previous.result : Promise.resolve(toolFailure());
    // Never evict a side-effect receipt and accidentally execute it again.
    if (calls.size >= 2048 || pending.size >= 64) return Promise.resolve(toolFailure());
    const result = bounded(async signal => {
      if (!active(params)) return toolFailure();
      const value = await entry.handler(args, { executorId, sessionId: params.threadId, turnId: params.turnId,
        callId: params.callId, requestId, sandbox, signal });
      if (!active(params) || signal.aborted) return toolFailure();
      const output = jsonCopy(value);
      if (!object(output) || typeof output.success !== 'boolean' || !Array.isArray(output.contentItems) ||
          output.contentItems.length > 32 || output.contentItems.some(item => !object(item) ||
            item.type !== 'inputText' || typeof item.text !== 'string')) return toolFailure();
      return { success: output.success, contentItems: output.contentItems.map(({ text }) => ({ type: 'inputText', text })) };
    }, params.turnId).catch(() => toolFailure());
    calls.set(key, { fingerprint, result });
    return result;
  }

  async function refresh(params, requestId) {
    const unavailable = () => failure('CODEX_AUTH_REFRESH_UNAVAILABLE', 'External authentication refresh is unavailable');
    // Credentials use only the dedicated host callback, never an approval card.
    if (closed || !refreshAuthTokens || !isAvailable() || params.reason !== 'unauthorized' ||
        (params.previousAccountId != null && (typeof params.previousAccountId !== 'string' || params.previousAccountId.length > 512)) ||
        authRequests.has(requestId) || authRequests.size >= 2048) throw unavailable();
    authRequests.add(requestId);
    if (authInFlight && authAccount !== (params.previousAccountId ?? null)) throw unavailable();
    if (!authInFlight) {
      authAccount = params.previousAccountId ?? null;
      authInFlight = bounded(async signal => {
        assertDirectory();
        const value = await refreshAuthTokens({ reason: params.reason, previousAccountId: params.previousAccountId ?? null }, { executorId, signal });
        if (closed || signal.aborted || !isAvailable()) throw unavailable();
        assertDirectory();
        if (!object(value) || typeof value.accessToken !== 'string' || !value.accessToken.trim() || value.accessToken.length > 32768 ||
            typeof value.chatgptAccountId !== 'string' || !value.chatgptAccountId.trim() || value.chatgptAccountId.length > 512 ||
            (params.previousAccountId != null && value.chatgptAccountId !== params.previousAccountId) ||
            (value.chatgptPlanType != null && (typeof value.chatgptPlanType !== 'string' || value.chatgptPlanType.length > 128))) throw unavailable();
        return { accessToken: value.accessToken, chatgptAccountId: value.chatgptAccountId,
          ...(value.chatgptPlanType != null ? { chatgptPlanType: value.chatgptPlanType } : {}) };
      }).catch(() => { throw unavailable(); });
    }
    const operation = authInFlight;
    try { return await operation; }
    finally { if (authInFlight === operation) authInFlight = null; }
  }

  function expire(turnId) {
    if (turnId !== undefined) revokedTurns.add(turnId);
    for (const entry of pending.values()) if (turnId === undefined || entry.turnId === turnId) entry.controller.abort();
  }
  return {
    enabled: tools.size > 0 || Boolean(refreshAuthTokens),
    dynamicTools: tools.size > 0, authRefresh: Boolean(refreshAuthTokens),
    startParams,
    bind(sessionId, sandbox) { policies.set(sessionId, sandbox); },
    handles: method => method === 'item/tool/call' || method === 'account/chatgptAuthTokens/refresh',
    request: (method, params, requestId) => method === 'item/tool/call' ? toolCall(params, requestId) : refresh(params, requestId),
    expire,
    close() { closed = true; expire(); calls.clear(); authRequests.clear(); policies.clear(); revokedTurns.clear(); }
  };
}
