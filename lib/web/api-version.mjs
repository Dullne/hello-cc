export const API_VERSION = 2;

function versionResult(value) {
  if (Array.isArray(value)) return { ok: false, version: null };
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return { ok: false, version: null };
  const version = Number(text);
  if (!Number.isSafeInteger(version)) return { ok: false, version: null };
  return { ok: version === API_VERSION, version };
}

export function readHttpApiVersion(req) {
  return versionResult(req?.headers?.['x-hcc-api-version']);
}

export function readWebSocketApiVersion(url) {
  return versionResult(url?.searchParams?.get('api_version'));
}

export function apiVersionUnsupportedBody() {
  return {
    ok: false,
    error: {
      code: 'API_VERSION_UNSUPPORTED',
      message: `Runtime API version ${API_VERSION} is required`,
      supported_version: API_VERSION
    }
  };
}

export function withRuntimeApiVersionHeader(headers = {}) {
  const versioned = {};
  const entries = typeof headers?.entries === 'function'
    ? headers.entries()
    : Object.entries(headers || {});
  for (const [name, value] of entries) {
    if (String(name).toLowerCase() === 'x-hcc-api-version') continue;
    versioned[name] = value;
  }
  versioned['X-HCC-API-Version'] = String(API_VERSION);
  return versioned;
}
