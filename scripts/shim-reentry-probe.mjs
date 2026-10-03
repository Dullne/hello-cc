// Test-only preload for the shim re-entry regression. Record fixed stage names
// and numeric metadata, never argv, environment values, headers or response data.
import fs from 'node:fs';
import diagnostics from 'node:diagnostics_channel';

const MAX_TRACE_BYTES = 16 * 1024;
const COMMANDS = new Set(['shim-ensure', 'find-root', 'peer-attach', 'peer-start']);
const EVENTS = new Set(['start', 'exit', 'request', 'headers', 'complete', 'error']);
const ROUTES = new Set(['/api/runtime', '/api/sessions/attach', '/api/sessions']);

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
