/** Read-only project data broker. Pane drafts, selection and control tokens never enter it. */
const SHARED_PATHS = new Set(['/api/projects', '/api/sessions', '/api/detected', '/api/state']);
const aborted = () => Object.assign(new Error('Request superseded'), { name: 'AbortError', code: 'REQUEST_SUPERSEDED' });

export function createReadBroker({ fetchJson, now = Date.now, ttlMs = 2400, maxEntries = 64 } = {}) {
  if (typeof fetchJson !== 'function' || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(ttlMs) || ttlMs < 0) throw new TypeError('Invalid read broker options');
  const entries = new Map();
  const pending = new Set();
  function read(url, options = {}) {
    const parsed = new URL(url, 'http://hcc.local');
    if (!SHARED_PATHS.has(parsed.pathname)) throw new TypeError('Only project read endpoints can be shared');
    const { signal, headers = {} } = options;
    if (signal?.aborted) return Promise.reject(aborted());
    const requestHeaders = Object.fromEntries(new globalThis.Headers(headers));
    const key = JSON.stringify([url, Object.entries(requestHeaders).sort(([a], [b]) => a.localeCompare(b))]);
    let entry = entries.get(key);
    if (entry && entry.done && now() - entry.completedAt >= ttlMs) { entries.delete(key); entry = null; }
    if (!entry) {
      // Never forget a pending request and silently create unlimited work.
      // Saturation rejects new distinct reads; existing shared consumers finish.
      if (pending.size >= maxEntries) return Promise.reject(Object.assign(new Error('Too many pending project reads'), { code: 'READ_BROKER_BUSY' }));
      if (entries.size >= maxEntries) {
        const completed = [...entries].find(([, value]) => value.done);
        if (completed) entries.delete(completed[0]);
      }
      const controller = new globalThis.AbortController();
      entry = { controller, users: 0, done: false, completedAt: 0 };
      const owned = entry;
      entries.set(key, entry);
      pending.add(entry);
      entry.promise = Promise.resolve().then(() => fetchJson(url, { headers: requestHeaders, signal: controller.signal }))
        .then(value => { pending.delete(owned); owned.done = true; owned.completedAt = now(); return value; }, error => {
          pending.delete(owned);
          owned.done = true;
          if (entries.get(key) === owned) entries.delete(key);
          throw error;
        });
    }
    entry.users++;
    const owned = entry;
    return new Promise((resolve, reject) => {
      let finished = false;
      function release() {
        if (finished) return false;
        finished = true; signal?.removeEventListener('abort', cancel); owned.controller.signal.removeEventListener('abort', cancel); owned.users--;
        if (!owned.done && owned.users === 0) {
          owned.controller.abort();
          if (entries.get(key) === owned) entries.delete(key);
        }
        return true;
      }
      function cancel() { if (release()) reject(aborted()); }
      signal?.addEventListener('abort', cancel, { once: true });
      owned.controller.signal.addEventListener('abort', cancel, { once: true });
      owned.promise.then(value => { if (release()) resolve(structuredClone(value)); }, error => { if (release()) reject(error); });
    });
  }
  return Object.freeze({ read, invalidate() {
    // Include completed cache entries: their current consumers may still be
    // waiting for a promise microtask when a write invalidates the read.
    const stale = new Set([...entries.values(), ...pending]);
    entries.clear();
    for (const entry of stale) entry.controller.abort();
  } });
}

export async function fetchJson(url, options = {}, { fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const controller = new globalThis.AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (options.signal?.aborted) throw aborted();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const json = await response.json();
    if (!response.ok) throw Object.assign(new Error(json.error?.message || json.message || 'Request failed'), {
      code: json.error?.code, detail: json.error?.message, status: response.status,
      ...(json.error?.extra && typeof json.error.extra === 'object' && !Array.isArray(json.error.extra) ? { extra: json.error.extra } : {})
    });
    return json;
  } catch (error) {
    if (timedOut) throw Object.assign(new Error('Request timed out; check the session before retrying a write.'), { code: 'REQUEST_TIMEOUT' });
    if (options.signal?.aborted) throw aborted();
    throw error;
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
}

export function sharedProjectBroker(surface = globalThis.window) {
  // Only the existing same-origin parent may lend its broker. No BroadcastChannel
  // or postMessage credential transfer, and no write/lease APIs are exposed.
  try { if (surface.parent !== surface && surface.parent.location.origin === surface.location.origin && surface.parent.hccProjectReads) return surface.parent.hccProjectReads; } catch {}
  if (surface.hccProjectReads) return surface.hccProjectReads;
  const broker = createReadBroker({ fetchJson });
  Object.defineProperty(surface, 'hccProjectReads', { value: broker, configurable: true });
  return broker;
}

export function createProjectRequests({ broker, fetcher = fetchJson, root = '', headers = {} }) {
  let scope = root, generation = 0;
  const pending = new Set();
  const cancel = () => { generation++; for (const controller of pending) controller.abort(); pending.clear(); };
  return {
    setRoot(value) { if (scope !== value) { cancel(); scope = value; } },
    dispose: cancel,
    async request(path, options = {}) {
      const visit = generation, controller = new globalThis.AbortController();
      const url = new URL(path, 'http://hcc.local');
      if (scope) url.searchParams.set('root', scope);
      const target = url.pathname + url.search;
      const read = !options.method || options.method.toUpperCase() === 'GET';
      const externalAbort = () => controller.abort();
      if (options.signal?.aborted) throw aborted();
      options.signal?.addEventListener('abort', externalAbort, { once: true });
      pending.add(controller);
      const requestOptions = { ...options, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...headers, ...options.headers } };
      if (!read) broker.invalidate();
      try {
        const data = await (read && SHARED_PATHS.has(url.pathname) ? broker.read(target, requestOptions) : fetcher(target, requestOptions));
        if (visit !== generation || controller.signal.aborted) throw aborted();
        return data;
      } finally {
        if (!read) broker.invalidate();
        pending.delete(controller); options.signal?.removeEventListener('abort', externalAbort);
      }
    }
  };
}

/** No overlapping polls; hidden tabs reduce their refresh rate and wake immediately. */
export function scheduleVisiblePoll(run, { intervalMs, hiddenMs = 30000, document: doc = globalThis.document, surface = globalThis.window, onError = console.error }) {
  let timer, stopped = false, running = false;
  const schedule = () => { clearTimeout(timer); if (!stopped) timer = setTimeout(tick, doc.hidden ? hiddenMs : intervalMs); };
  async function tick() {
    if (stopped || running) return;
    running = true;
    try { if (surface.navigator?.onLine !== false) await run(); } catch (error) { if (error.name !== 'AbortError') onError(error); }
    finally { running = false; schedule(); }
  }
  function wake() { if (!doc.hidden) { clearTimeout(timer); void tick(); } else schedule(); }
  doc.addEventListener('visibilitychange', wake); surface.addEventListener('online', wake); schedule();
  return () => { stopped = true; clearTimeout(timer); doc.removeEventListener('visibilitychange', wake); surface.removeEventListener('online', wake); };
}
