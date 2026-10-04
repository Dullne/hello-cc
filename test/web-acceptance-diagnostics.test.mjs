import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { acceptanceSourceLocation, webAcceptanceDiagnostics } from '../scripts/web-acceptance-diagnostics.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-diagnostics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, write(relative, value) {
    const filename = path.join(directory, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value));
    return filename;
  } };
}

test('public source diagnostic contains only fixed fields and a controlled stack location', t => {
  const f = fixture(t), secret = 'TOKEN_SECRET_URL_ROOT_ASSET';
  f.write('source/evidence.json', {
    success: false, phase: secret + '\n::warning::injected', checks: [secret, { url: secret }],
    url: 'https://example.invalid/?token=' + secret, sourceRoot: '/private/' + secret,
    assets: [{ content: secret }], failure: { message: secret,
      stack: `Error: ${secret}\n    at internal (/private/${secret}/lib/web/http.mjs:12:3)\n    at async runSessionToolsChecks (file:///private/${secret}/scripts/web-session-tools-checks.mjs:26:48)` }
  });
  assert.deepEqual(webAcceptanceDiagnostics({ outputDir: f.directory, sourceOutcome: 'failure', installedOutcome: 'skipped' }), [
    '::error title=Web acceptance diagnostic::phase=source-browser step=failure receipt=present result=failure completed_checks=2 source=web-session-tools-checks.mjs:26:48'
  ]);
});

test('installed child failure remains visible independently of the wrapper error', t => {
  const f = fixture(t);
  f.write('installed/evidence.json', { success: false, checks: ['package ready'], failure: {
    stack: 'Error: wrapped\n    at run (file:///private/install/scripts/web-workbench-installed-acceptance.mjs:64:34)' } });
  f.write('installed/browser/evidence.json', { success: false, checks: Array(13).fill('passed'), failure: {
    stack: 'AssertionError: secret\n    at runSessionToolsChecks (file:///private/package/scripts/web-session-tools-checks.mjs:26:48)' } });
  const lines = webAcceptanceDiagnostics({ outputDir: f.directory, sourceOutcome: 'success', installedOutcome: 'failure' });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /phase=installed-package .*completed_checks=1 source=web-workbench-installed-acceptance.mjs:64:34$/);
  assert.match(lines[1], /phase=installed-browser .*completed_checks=13 source=web-session-tools-checks.mjs:26:48$/);
});

test('missing parent does not hide a successful child when the installed step fails later', t => {
  const f = fixture(t);
  f.write('installed/browser/evidence.json', { success: true, checks: ['one', 'two'] });
  const lines = webAcceptanceDiagnostics({ outputDir: f.directory, sourceOutcome: 'success', installedOutcome: 'failure' });
  assert.match(lines[0], /phase=installed-package .*receipt=missing result=unknown completed_checks=unknown source=unavailable$/);
  assert.match(lines[1], /phase=installed-browser .*receipt=present result=success completed_checks=2 source=unavailable$/);
});

test('missing, malformed and oversized receipts produce bounded diagnostics without raw errors', t => {
  const f = fixture(t);
  const options = { outputDir: f.directory, sourceOutcome: 'failure', installedOutcome: 'skipped' };
  assert.match(webAcceptanceDiagnostics(options)[0], /receipt=missing result=unknown/);
  for (const value of ['SECRET_MALFORMED', 'null', '[]', 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    f.write('source/evidence.json', value);
    assert.match(webAcceptanceDiagnostics(options)[0], /receipt=invalid result=unknown completed_checks=unknown source=unavailable$/);
  }
});

test('receipts cannot redirect diagnostics through a symlink or receipt-owned path', t => {
  const f = fixture(t);
  const other = f.write('other.json', { success: false, checks: ['secret'] });
  fs.mkdirSync(path.join(f.directory, 'source'));
  fs.symlinkSync(other, path.join(f.directory, 'source', 'evidence.json'));
  assert.match(webAcceptanceDiagnostics({ outputDir: f.directory, sourceOutcome: 'failure', installedOutcome: 'skipped' })[0], /receipt=invalid/);
  f.write('installed/evidence.json', { success: false, browserReceipt: other, checks: [] });
  assert.equal(webAcceptanceDiagnostics({ outputDir: f.directory, sourceOutcome: 'success', installedOutcome: 'failure' }).length, 1);
});

test('source locations reject URLs, unknown scripts, command injection and unbounded positions', () => {
  for (const location of [
    'https://secret.invalid/scripts/web-session-tools-checks.mjs:26:48',
    'file:///private/scripts/unknown.mjs:26:48',
    'file:///private/scripts/web-session-tools-checks.mjs:26:48?token=secret',
    'file:///private/scripts/web-session-tools-checks.mjs:26:48#secret',
    'file:///private/scripts/web-session-tools-checks.mjs:0:48',
    'file:///private/scripts/web-session-tools-checks.mjs:1234567:48',
    'file:///private/scripts/web-session-tools-checks.mjs:26:48%0A::warning::secret',
    'web-session-tools-checks.mjs:26:48'
  ]) assert.equal(acceptanceSourceLocation('Error: ignored\n    at run (' + location + ')'), 'unavailable');
  assert.equal(acceptanceSourceLocation('at /private/scripts/web-session-tools-checks.mjs:26:48'), 'unavailable');
  assert.equal(acceptanceSourceLocation('Error: ' + 'x'.repeat(65536)), 'unavailable');
  assert.equal(acceptanceSourceLocation({ toString() { throw new Error('not read'); } }), 'unavailable');
  assert.equal(acceptanceSourceLocation('Error: ignored\n    at C:\\checkout\\scripts\\web-workbench-acceptance.mjs:398:2'), 'web-workbench-acceptance.mjs:398:2');
});

test('untrusted phase, checks and outcome payloads cannot become public fields', t => {
  const f = fixture(t);
  f.write('source/evidence.json', { success: 'failure\n::error::secret', phase: 'secret', checks: { length: 42 }, failure: { stack: 'Error: secret' } });
  assert.match(webAcceptanceDiagnostics({ outputDir: f.directory, sourceOutcome: 'failure', installedOutcome: 'skipped' })[0], /result=unknown completed_checks=unknown source=unavailable$/);
  assert.throws(() => webAcceptanceDiagnostics({ outputDir: f.directory, sourceOutcome: 'failure\n::error::secret', installedOutcome: 'skipped' }), /Invalid acceptance diagnostics options/);
  assert.deepEqual(webAcceptanceDiagnostics({ outputDir: f.directory, sourceOutcome: 'success', installedOutcome: 'skipped' }), []);
});

test('CLI argument failures emit only a fixed diagnostic and no raw exception', () => {
  const script = fileURLToPath(new URL('../scripts/web-acceptance-diagnostics.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--SECRET_URL_TOKEN_ROOT', 'secret'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '::error title=Web acceptance diagnostic::phase=diagnostics receipt=unavailable\n');
});
