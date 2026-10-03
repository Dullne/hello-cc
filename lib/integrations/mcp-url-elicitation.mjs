// The same bounded URL contract runs in the responder and browser. Acceptance
// acknowledges an out-of-band flow; it never proves authentication succeeded.
export function createMcpUrlValidator() {
  function fail() {
    throw Object.assign(new Error('MCP authorization needs a valid HTTPS URL (or loopback HTTP) and elicitation identity'), { code: 'INTERACTION_RESPONSE_INVALID' });
  }
  function describe(params) {
    if (!params || params.mode !== 'url' || typeof params.elicitationId !== 'string' ||
        !params.elicitationId.trim() || params.elicitationId.length > 512 || /[\u0000-\u001f\u007f]/.test(params.elicitationId) ||
        typeof params.url !== 'string' || !params.url || params.url.length > 8192 || /[\\\s\u0000-\u001f\u007f]/.test(params.url)) fail();
    let url;
    try { url = new URL(params.url); } catch { fail(); }
    if (url.username || url.password || !url.hostname || !['http:', 'https:'].includes(url.protocol) ||
        (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail();
    return { href: url.href, origin: url.origin, loopback: ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) };
  }
  return { describe };
}

// Pending request parameters exist in live memory only. Event histories must
// not retain authorization URLs, device codes, opaque ids, messages or metadata.
export function redactMcpUrlInteraction(request) {
  if (request?.method !== 'mcpServer/elicitation/request' || request.params?.mode !== 'url') return request;
  return { ...request, params: { mode: 'url', serverName: request.params.serverName } };
}
