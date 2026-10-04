// Fixture traffic alternates HTTP requests with synchronous CLI work. Close
// each response's connection so later requests cannot inherit its idle socket.
// Use this from the fixture's first request: it cannot isolate a socket pool
// already populated by other fetch callers. Never replay uncertain mutations.
export function fixtureFetch(input, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('Connection', 'close');
  return globalThis.fetch(input, { ...options, headers });
}
