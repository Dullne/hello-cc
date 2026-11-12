// Shared by dispatch output and CI annotations. Only fixed enums and numeric
// timings cross this boundary; error messages, URLs and peer IDs never do.
const STAGES = new Map([
  ['runtime_lookup', [null, null]],
  ['session_list', ['GET', '/api/sessions']],
  ['input', ['POST', '/api/sessions/:peer/input']]
]);
const CODES = new Set(['RUNTIME_NOT_RUNNING', 'RUNTIME_UNREACHABLE']);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'TimeoutError', 'AbortError']);
const duration = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function taskDispatchRuntimeFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !STAGES.has(value.stage) || !CODES.has(value.code)) return null;
  const [method, path] = STAGES.get(value.stage);
  return {
    stage: value.stage, code: value.code, method, path,
    elapsedMs: duration(value.elapsedMs),
    timeoutMs: method ? duration(value.timeoutMs) : null,
    errorName: method && ERROR_NAMES.has(value.errorName) ? value.errorName : null
  };
}
