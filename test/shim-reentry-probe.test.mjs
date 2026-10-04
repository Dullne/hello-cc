import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { readOwnedReentryOutputAtDeadline, readReentryTrace } from '../scripts/shim-reentry-probe.mjs';

const regressionSource = fs.readFileSync(new URL('../scripts/regression.mjs', import.meta.url), 'utf8');
const waitSource = regressionSource.slice(regressionSource.indexOf('async function waitForFileContent('),
  regressionSource.indexOf('\nasync function waitForFileLineCount('));

for (const example of [
  { name: 'ordinary timely output', writeAt: 5000, resumeAt: 5000, accepted: true, classification: null },
  { name: 'write in the last polling sleep', writeAt: 9950, resumeAt: 10000, accepted: true, classification: 'matched_before_deadline' },
  { name: 'timely write followed by a delayed wake', writeAt: 9950, resumeAt: 10400, accepted: true, classification: 'matched_before_deadline' },
  { name: 'late write before a delayed wake', writeAt: 10050, resumeAt: 10400, accepted: false, classification: 'late' },
  { name: 'missing output', writeAt: null, accepted: false, classification: 'missing' },
  { name: 'incorrect timely output', writeAt: 9950, resumeAt: 10000, contents: 'wrong', accepted: false, classification: 'mismatch' },
  { name: 'output changed during the final read', writeAt: 9950, resumeAt: 10400, contents: 'wrong', mutateOnRead: true,
    accepted: false, classification: 'changed_during_read' }
]) {
  test(`owned shim deadline: ${example.name}`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-shim-deadline-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'output'), epoch = Date.now();
    const expected = 'fake-claude --resume shim-regression-session';
    let elapsed = 0, wrote = false, final = null, inFinalRead = false, finalReads = 0, finalFd;
    let diagnostic = '';
    const sleepDurations = [];
    const writeAt = (text, ms) => {
      fs.writeFileSync(file, text + '\n');
      fs.utimesSync(file, new Date(epoch + ms), new Date(epoch + ms));
    };
    if (example.writeAt !== null) writeAt('pending', 0);
    const read = fs.readSync;
    t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
      if (inFinalRead) {
        finalReads++; finalFd = fd;
        assert.ok(length <= 4096);
        if (example.mutateOnRead) writeAt(expected, 10050);
      }
      return read(fd, buffer, offset, length, position);
    });
    const context = vm.createContext({
      fs, Date: { now: () => epoch + elapsed },
      process: { env: {}, stderr: { write: text => { diagnostic += text; } } },
      fail: message => { throw new Error(message); },
      ensureFile: (target, value) => assert.equal(fs.readFileSync(target, 'utf8').trim(), value),
      readOwnedReentryOutputAtDeadline: (...args) => {
        inFinalRead = true;
        try { final = readOwnedReentryOutputAtDeadline(...args); return final; }
        finally { inFinalRead = false; }
      },
      sleep: async ms => {
        sleepDurations.push(ms);
        const next = elapsed + ms;
        if (!wrote && example.writeAt !== null && (example.writeAt <= next ||
            (elapsed === 9900 && example.writeAt <= example.resumeAt))) {
          writeAt(example.contents || expected, example.writeAt); wrote = true;
          elapsed = Math.max(next, example.resumeAt);
        } else elapsed = next;
      }
    });
    const wait = vm.runInContext('(' + waitSource + ')', context);
    const waiting = wait(file, expected, 'owned output', {
      ownedReentryOutput: true, diagnostics: () => ({ fixture: 'shim-reentry' })
    });
    if (example.accepted) await waiting;
    else await assert.rejects(waiting, /timed out waiting for owned output/);
    assert.equal(final?.classification || null, example.classification);
    assert.equal(finalReads, final && example.classification !== 'missing' ? 1 : 0);
    assert.ok(sleepDurations.every(ms => ms === 100), 'the original polling interval is unchanged');
    assert.equal(elapsed, example.resumeAt ?? 10000, 'there is no additional wait after the last wake');
    if (finalFd !== undefined) assert.throws(() => fs.fstatSync(finalFd), { code: 'EBADF' });
    if (!example.accepted) {
      const detail = JSON.parse(diagnostic.replace(/^Shim regression diagnostic: /, ''));
      assert.equal(detail.wait.started_at_ms, epoch);
      assert.equal(detail.wait.deadline_ms, epoch + 10000);
      assert.equal(detail.wait.last_read_at_ms, example.writeAt === null ? null : epoch + 9900);
      assert.equal(detail.wait.final_observation.classification, example.classification);
      assert.equal(detail.wait.final_observation.observed_at_ms, epoch + elapsed);
      assert.doesNotMatch(diagnostic, /fake-claude|pending|wrong|output/);
    }
  });
}

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
