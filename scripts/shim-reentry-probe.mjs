// Test-only preload for the shim re-entry regression. Record fixed stage names
// and numeric metadata, never argv, environment values, headers or response data.
import fs from 'node:fs';
import diagnostics from 'node:diagnostics_channel';

const MAX_TRACE_BYTES = 16 * 1024;
const MAX_REENTRY_OUTPUT_BYTES = 4096;
const COMMANDS = new Set(['shim-ensure', 'find-root', 'peer-attach', 'peer-start']);
const EVENTS = new Set(['start', 'exit', 'request', 'headers', 'complete', 'error']);
const ROUTES = new Set(['/api/runtime', '/api/sessions/attach', '/api/sessions']);

// Only for this fixture's ordinary, shell-redirected output. A final read may
// observe a write missed by the last poll, but must not accept a late write.
// This is not a timing proof for arbitrary or deliberately backdated files.
export function readOwnedReentryOutputAtDeadline(file, expected, deadline, observedAt = Date.now()) {
  const result = { matched: false, classification: 'missing', observed_at_ms: observedAt,
    mtime_ms: null, size_bytes: null, bytes_read: 0 };
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd);
    result.mtime_ms = before.mtimeMs;
    result.size_bytes = before.size;
    if (!before.isFile()) { result.classification = 'not_regular'; return result; }
    if (before.size > MAX_REENTRY_OUTPUT_BYTES) { result.classification = 'too_large'; return result; }
    const bytes = Buffer.alloc(before.size);
    result.bytes_read = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd);
    result.mtime_ms = after.mtimeMs;
    result.size_bytes = after.size;
    if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) {
      result.classification = 'changed_during_read';
    } else if (after.mtimeMs > deadline) {
      result.classification = 'late';
    } else if (result.bytes_read !== after.size || bytes.toString('utf8').trim() !== expected) {
      result.classification = 'mismatch';
    } else {
      result.matched = true;
      result.classification = 'matched_before_deadline';
    }
    return result;
  } catch (error) {
    if (error.code !== 'ENOENT') result.classification = 'read_error';
    return result;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function classifyReentryCommand(argv, expectedEntry) {
  if (!expectedEntry || argv[1] !== expectedEntry) return null;
  if (argv[2] === 'shim' && argv[3] === 'ensure') return 'shim-ensure';
  if (argv[2] === 'find-root') return 'find-root';
  if (argv[2] === 'peer' && argv[3] === 'attach') return 'peer-attach';
  if (argv[2] === 'peer' && argv[3] === 'start') return 'peer-start';
  return null;
}

export function readReentryTrace(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const bytes = Buffer.alloc(Math.min(fs.fstatSync(fd).size, MAX_TRACE_BYTES));
    fs.readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.toString('utf8').split('\n').flatMap(line => {
      let row;
      try { row = JSON.parse(line); } catch { return []; }
      if (!COMMANDS.has(row?.command) || !EVENTS.has(row?.event) ||
          !Number.isSafeInteger(row.at) || !Number.isSafeInteger(row.pid)) return [];
      const safe = { at: row.at, pid: row.pid, command: row.command, event: row.event };
      if (ROUTES.has(row.route)) safe.route = row.route;
      if (Number.isInteger(row.status) && row.status >= 0 && row.status <= 599) safe.status = row.status;
      return [safe];
    }).slice(-64);
  } catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

const traceFile = process.env.HCC_REGRESSION_REENTRY_TRACE;
const command = classifyReentryCommand(process.argv, process.env.HCC_REGRESSION_REENTRY_BIN);
if (traceFile && command) {
  const record = (event, route, status) => {
    let fd;
    try {
      fd = fs.openSync(traceFile, 'a', 0o600);
      if (fs.fstatSync(fd).size >= MAX_TRACE_BYTES) return;
      fs.writeSync(fd, JSON.stringify({ at: Date.now(), pid: process.pid, command, event,
        ...(ROUTES.has(route) ? { route } : {}),
        ...(Number.isInteger(status) ? { status } : {}) }) + '\n');
    } catch { /* Diagnostics must not change the tested command's result. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  record('start');
  process.once('exit', code => record('exit', undefined, code));
  // The isolated regression runtime uses HTTP/fetch. These passive Undici
  // channels preserve the real request implementation and its original budget.
  for (const [channel, event] of [
    ['undici:request:create', 'request'],
    ['undici:request:headers', 'headers'],
    ['undici:request:trailers', 'complete'],
    ['undici:request:error', 'error']
  ]) {
    diagnostics.subscribe(channel, ({ request, response }) => {
      if (ROUTES.has(request?.path)) record(event, request.path, response?.statusCode);
    });
  }
}
