const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';

function isSecretKey(key) {
  const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'authorization' ||
    normalized === 'cookie' ||
    normalized === 'setcookie' ||
    normalized.includes('secret') ||
    normalized.endsWith('password') ||
    normalized.endsWith('credential') ||
    normalized.endsWith('credentials') ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('privatekey') ||
    normalized.endsWith('token');
}

function redactString(value) {
  return String(value)
    .replace(/\b(?:cookie|set-cookie)\s*:\s*[^\r\n]*/gi, (header) => `${header.split(':', 1)[0]}: ${REDACTED}`)
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(/(--token(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, `$1${REDACTED}`)
    .replace(/([?&](?:token|access_token|api_key)=)[^&#\s]*/gi, `$1${REDACTED}`)
    .replace(/(hcc_sid=)[^;\s]*/gi, `$1${REDACTED}`);
}

export function redactCliArgs(args) {
  const values = Array.from(args || [], (entry) => String(entry));
  return values.map((entry, index) => {
    if (index > 0 && values[index - 1] === '--token') return REDACTED;
    if (entry.startsWith('--token=')) return `--token=${REDACTED}`;
    return redactString(entry);
  });
}

export function redactSecrets(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  try {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message || ''),
        stack: redactString(value.stack || '')
      };
    }
    if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, seen));

    const clone = {};
    for (const [key, entry] of Object.entries(value)) {
      clone[key] = isSecretKey(key) ? REDACTED : redactSecrets(entry, seen);
    }
    return clone;
  } finally {
    seen.delete(value);
  }
}
