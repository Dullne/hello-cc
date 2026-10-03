import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CODEX_PROTOCOL_SCHEMA_PATHS, inspectCodexProtocol } from '../lib/diagnostics/codex-protocol.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/codex-protocol-0.144.6.json', import.meta.url));
const original = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).schemas;
const failed = result => result.checks.filter(check => check.status === 'fail').map(check => check.contract);

test('the installed official protocol subset passes without pretending to handle every server request', () => {
  const report = inspectCodexProtocol(original);
  assert.equal(report.status, 'compatible');
  assert.deepEqual(failed(report), []);
  assert.ok(report.unsupportedServerRequests.includes('account/chatgptAuthTokens/refresh'));
  assert.ok(report.unsupportedServerRequests.includes('item/tool/call'));
  assert.equal(report.accountAccessed, false); assert.equal(report.inferenceCalled, false);
});

test('missing active-turn notifications and supported interaction methods fail the upgrade gate', () => {
  const schemas = structuredClone(original);
  for (const [name, method] of [['ServerNotification', 'turn/completed'], ['ServerRequest', 'item/permissions/requestApproval']]) {
    schemas[name].oneOf = schemas[name].oneOf.filter(row => !row.properties.method.enum.includes(method));
  }
  const report = inspectCodexProtocol(schemas);
  assert.equal(report.status, 'incompatible');
  assert.deepEqual(failed(report), ['ServerRequest: item/permissions/requestApproval', 'ServerNotification: turn/completed']);
});

test('a new required reply field or removal of a human decision is incompatible', () => {
  const schemas = structuredClone(original);
  schemas.McpServerElicitationRequestResponse.required.push('newRequiredToken');
  schemas.McpServerElicitationRequestResponse.definitions.McpServerElicitationAction.enum = ['accept', 'cancel'];
  const report = inspectCodexProtocol(schemas);
  assert.equal(report.status, 'incompatible');
  assert.deepEqual(failed(report), ['McpServerElicitationRequestResponse: no new required response fields',
    'McpServerElicitationRequestResponse: action choices']);
});

test('URL correlation identity is required even if form mode and all method names remain present', () => {
  const schemas = structuredClone(original);
  const url = schemas.McpServerElicitationRequestParams.oneOf.find(row => row.properties.mode.enum.includes('url'));
  url.required = url.required.filter(field => field !== 'elicitationId');
  const report = inspectCodexProtocol(schemas);
  assert.equal(report.status, 'incompatible');
  assert.deepEqual(failed(report), ['MCP elicitation: url identity and payload']);
});

test('an absent or unknown schema never produces a compatible receipt', () => {
  const report = inspectCodexProtocol({});
  assert.equal(report.status, 'incompatible'); assert.ok(failed(report).length > 20);
});

test('protocol CLI isolates home, preserves existing output, and hashes generated artifacts', t => {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-protocol-cli-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'output'), fake = path.join(directory, 'codex');
  fs.writeFileSync(fake, `#!${process.execPath}\n` + `
    const fs = require('node:fs'), path = require('node:path');
    if (process.env.HOME === ${JSON.stringify(process.env.HOME)} || process.env.CODEX_HOME === ${JSON.stringify(process.env.CODEX_HOME)}) process.exit(5);
    if (process.argv[2] === '--version') { console.log('codex-cli 0.144.6'); process.exit(0); }
    if (process.argv[2] !== 'app-server' || !process.argv.includes('--experimental')) process.exit(6);
    const out = process.argv[process.argv.indexOf('--out') + 1];
    fs.mkdirSync(out);
    if (process.argv[3] === 'generate-json-schema') {
      const schemas = JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)}, 'utf8')).schemas;
      const schemaPaths = ${JSON.stringify(CODEX_PROTOCOL_SCHEMA_PATHS)};
      for (const [name, schema] of Object.entries(schemas)) {
        const file = path.join(out, schemaPaths[name] || name + '.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(schema));
      }
    } else if (process.argv[3] === 'generate-ts') {
      for (const name of ['ClientRequest', 'ServerRequest']) fs.writeFileSync(path.join(out, name + '.ts'), 'export type ' + name + ' = unknown;');
    } else process.exit(7);
  `, { mode: 0o700 });
  const cli = fileURLToPath(new URL('../scripts/codex-protocol.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30000 });
  const result = run(['--codex-bin', fake, '--out', output]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'compatible'); assert.equal(receipt.codexVersion, '0.144.6');
  const manifest = fs.readFileSync(path.join(output, 'manifest.json'), 'utf8');
  assert.equal(JSON.parse(manifest).files.length, receipt.fileCount);
  assert.ok(JSON.parse(manifest).files.some(file => file.path === 'json-schema/' + CODEX_PROTOCOL_SCHEMA_PATHS.GetAccountResponse));
  assert.equal(fs.existsSync(path.join(output, 'json-schema', 'GetAccountResponse.json')), false, 'fixture matches official v2 account layout');
  assert.match(receipt.bundleSha256, /^[a-f0-9]{64}$/);
  const duplicate = run(['--codex-bin', fake, '--out', output]);
  assert.equal(duplicate.status, 1);
  assert.equal(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'), manifest);
  assert.match(duplicate.stderr, /already exists/);
  const second = run(['--codex-bin', fake, '--out', path.join(directory, 'second')]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).bundleSha256, receipt.bundleSha256);
});


test('read-only account refresh and quota field changes fail the protocol upgrade gate', () => {
  const schemas=structuredClone(original); delete schemas.GetAccountParams.properties.refreshToken;
  schemas.GetAccountRateLimitsResponse.definitions.RateLimitWindow.required=[];
  const report=inspectCodexProtocol(schemas);
  assert.equal(report.status,'incompatible');
  assert.deepEqual(failed(report),['Account read: explicit nonrefreshing option','Account limits: window percentage']);
});
