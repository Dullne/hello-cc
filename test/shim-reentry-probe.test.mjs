import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { readReentryTrace } from '../scripts/shim-reentry-probe.mjs';

test('shim probe distinguishes a pending runtime request and preserves stdout and exit code', { timeout: 10000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-reentry-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entry = path.join(dir, 'hcc.mjs');
  const trace = path.join(dir, 'trace');
  fs.writeFileSync(entry, `await fetch(process.env.PROBE_TEST_URL, {
    method: 'POST', headers: { authorization: 'Bearer fixture-header-secret' }, body: 'fixture-body-secret'
  });
  console.log('provider-output');
  process.exitCode = 7;
  `);
  let respond;
  const received = new Promise(resolve => { respond = resolve; });
  const server = http.createServer((req, res) => respond(res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const probe = pathToFileURL(path.resolve(import.meta.dirname, '../scripts/shim-reentry-probe.mjs')).href;
  const child = spawn(process.execPath, ['--import', probe, entry, 'peer', 'attach', 'fixture-argv-secret'], {
    env: {
      HCC_REGRESSION_REENTRY_TRACE: trace, HCC_REGRESSION_REENTRY_BIN: entry,
      PROBE_TEST_URL: `http://127.0.0.1:${server.address().port}/api/runtime`,
      PROBE_SECRET: 'fixture-env-secret'
    }, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'close');
  const response = await received;
  const pending = readReentryTrace(trace);
  assert.ok(pending.some(row => row.command === 'peer-attach' && row.event === 'request' && row.route === '/api/runtime'));
  assert.equal(pending.some(row => row.event === 'complete' || row.event === 'exit'), false);
  response.end('{}');
  const [code] = await exited;
  assert.equal(code, 7);
  assert.equal(stdout, 'provider-output\n');
  assert.equal(stderr, '');
  const rows = readReentryTrace(trace);
  assert.ok(rows.some(row => row.event === 'headers' && row.status === 200));
  assert.ok(rows.some(row => row.event === 'complete'));
  assert.ok(rows.some(row => row.event === 'exit' && row.status === 7));
  assert.doesNotMatch(fs.readFileSync(trace, 'utf8'), /fixture-(?:header|body|argv|env)-secret|authorization/);
});

test('shim trace readback bounds output and excludes unrecognized fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-reentry-trace-'));
  try {
    const trace = path.join(dir, 'trace');
    const row = { at: 1, pid: 2, command: 'shim-ensure', event: 'start',
      route: '/private?token=fixture-secret', args: ['fixture-secret'], environment: 'fixture-secret' };
    fs.writeFileSync(trace, JSON.stringify(row) + '\n' + '{malformed}\n' +
      JSON.stringify({ ...row, command: 'fixture-secret' }) + '\n');
    assert.deepEqual(readReentryTrace(trace), [{ at: 1, pid: 2, command: 'shim-ensure', event: 'start' }]);
    fs.writeFileSync(trace, (JSON.stringify(row) + '\n').repeat(1000));
    const result = readReentryTrace(trace);
    assert.ok(result.length > 0 && result.length <= 64);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
