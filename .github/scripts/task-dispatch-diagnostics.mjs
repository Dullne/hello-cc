// CI-only extraction from a bounded log tail. Never publish the failure JSON:
// it contains task text, messages, peer identifiers and potentially paths.
const MAX_LOG_BYTES = 256 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_MARKERS = 16;
const MARKER = /^(?:Error: )?task dispatch (?:injected default natural-language prompt into shell session|did not inject explicit shell-safe message):\r?\n/gm;
const DELIVERY = new Set(['message-only', 'message+inject']);
const REASON = new Set(['injected', 'no_inject', 'runtime_unavailable', 'session_not_running',
  'unsupported_session_kind', 'target_busy']);
const KIND = new Set(['shell', 'claude', 'codex', 'dsh', 'other']);
const STATUS = new Set(['starting', 'running', 'disconnected', 'detached', 'exited']);
const allowed = (value, values) => typeof value === 'string' && values.has(value) ? value : null;

function followingObject(text, start) {
  let offset = start;
  while (offset - start < MAX_JSON_BYTES && /[ \t\r\n]/.test(text[offset] || '\0')) offset++;
  if (text[offset] !== '{') return null;
  const stack = [];
  let quoted = false, escaped = false;
  for (let index = offset; index < text.length && index - start < MAX_JSON_BYTES; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) return null;
      if (stack.length) continue;
      const end = index + 1;
      // The complete JSON must end its line, before any stack trace lines.
      if (!/^[ \t]*(?:\r?\n|$)/.test(text.slice(end))) return null;
      const raw = text.slice(offset, end);
      if (Buffer.byteLength(raw) > MAX_JSON_BYTES) return null;
      try { return { value: JSON.parse(raw), end }; } catch { return null; }
    }
  }
  return null;
}

export function taskDispatchFailureDiagnostics(log) {
  if (typeof log !== 'string') return [];
  // Bound both allocation and UTF-8 input size, even outside the workflow.
  const text = Buffer.from(log.slice(-MAX_LOG_BYTES)).subarray(-MAX_LOG_BYTES).toString('utf8')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const marker = new RegExp(MARKER);
  const diagnostics = [], seen = new Set();
  let attempts = 0;
  while (attempts++ < MAX_MARKERS && marker.exec(text)) {
    const parsed = followingObject(text, marker.lastIndex);
    if (!parsed) continue;
    marker.lastIndex = parsed.end;
    const value = parsed.value;
    const session = value.session && typeof value.session === 'object' && !Array.isArray(value.session)
      ? value.session : null;
    const diagnostic = {
      injected: typeof value.injected === 'boolean' ? value.injected : null,
      delivery: allowed(value.delivery, DELIVERY),
      injectionReason: allowed(value.injection_reason, REASON),
      sessionPresent: session !== null,
      sessionKind: allowed(session?.kind, KIND),
      sessionStatus: allowed(session?.status, STATUS)
    };
    const key = JSON.stringify(diagnostic);
    if (!seen.has(key)) { diagnostics.push(diagnostic); seen.add(key); }
    if (diagnostics.length === 2) break;
  }
  return diagnostics;
}
