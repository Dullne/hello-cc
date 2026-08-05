import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createPublicKey, X509Certificate } from 'node:crypto';
import * as webTls from '../lib/web/tls.mjs';
import { readRuntime } from '../lib/runtime/state.mjs';
import { runtimeHttpRequest } from '../lib/web/runtime.mjs';

function currentGeneration(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.hello-cc', 'tls', 'current.json'), 'utf8')).generation;
}

async function assertCredentialsStartTls(credentials) {
  const server = https.createServer({ key: credentials.key, cert: credentials.cert }, (_req, res) => res.end('tls-ok'));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const body = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: '127.0.0.1',
        servername: 'localhost',
        port: server.address().port,
        ca: credentials.cert
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve(text));
      });
      req.once('error', reject);
      req.end();
    });
    assert.equal(body, 'tls-ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('TLS credential reuse rejects invalid time, SAN, and key evidence', (t) => {
  assert.equal(typeof webTls.tlsCredentialsAreReusable, 'function');

  const originalHome = process.env.HOME;
  const primaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-tls-primary-'));
  const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-tls-other-'));
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(primaryHome, { recursive: true, force: true });
    fs.rmSync(otherHome, { recursive: true, force: true });
  });

  process.env.HOME = primaryHome;
  const primary = webTls.ensureSelfSignedCert();
  process.env.HOME = otherHome;
  const other = webTls.ensureSelfSignedCert();
  const certificate = new X509Certificate(primary.cert);
  const validFromMs = Date.parse(certificate.validFrom);
  const validToMs = Date.parse(certificate.validTo);
  const sans = ['DNS:localhost', 'IP:127.0.0.1'];

  assert.equal(webTls.tlsCredentialsAreReusable({
    key: primary.key,
    cert: primary.cert,
    sanEntries: sans,
    nowMs: validFromMs + 1000
  }), true);
  assert.equal(webTls.tlsCredentialsAreReusable({
    key: primary.key,
    cert: primary.cert,
    sanEntries: sans,
    nowMs: validFromMs - 1
  }), false, 'not-yet-valid certificate was reusable');
  assert.equal(webTls.tlsCredentialsAreReusable({
    key: primary.key,
    cert: primary.cert,
    sanEntries: sans,
    nowMs: validToMs + 1
  }), false, 'expired certificate was reusable');
  assert.equal(webTls.tlsCredentialsAreReusable({
    key: primary.key,
    cert: primary.cert,
    sanEntries: ['DNS:not-covered.example.test'],
    nowMs: validFromMs + 1000
  }), false, 'SAN-mismatched certificate was reusable');
  assert.equal(webTls.tlsCredentialsAreReusable({
    key: other.key,
    cert: primary.cert,
    sanEntries: sans,
    nowMs: validFromMs + 1000
  }), false, 'key-mismatched certificate was reusable');
});

test('ensureSelfSignedCert rotates SAN and key mismatches into usable generations', async (t) => {
  const originalHome = process.env.HOME;
  const primaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-tls-rotate-'));
  const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-tls-rotate-key-'));
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(primaryHome, { recursive: true, force: true });
    fs.rmSync(otherHome, { recursive: true, force: true });
  });

  process.env.HOME = otherHome;
  const other = webTls.ensureSelfSignedCert();
  process.env.HOME = primaryHome;
  webTls.ensureSelfSignedCert();
  const initialGeneration = currentGeneration(primaryHome);

  const requiredSan = 'task5-san.example.test';
  const sanRotated = webTls.ensureSelfSignedCert([requiredSan]);
  const sanGeneration = currentGeneration(primaryHome);
  assert.notEqual(sanGeneration, initialGeneration, 'SAN mismatch did not rotate current.json');
  assert.equal(new X509Certificate(sanRotated.cert).checkHost(requiredSan, { subject: 'never' }), requiredSan);
  await assertCredentialsStartTls(sanRotated);

  const tlsDir = path.join(primaryHome, '.hello-cc', 'tls');
  fs.writeFileSync(path.join(tlsDir, sanGeneration, 'self-signed.key'), other.key, { mode: 0o600 });
  const keyRotated = webTls.ensureSelfSignedCert([requiredSan]);
  const keyGeneration = currentGeneration(primaryHome);
  assert.notEqual(keyGeneration, sanGeneration, 'key mismatch did not rotate current.json');
  const certificateKey = new X509Certificate(keyRotated.cert).publicKey.export({ format: 'der', type: 'spki' });
  const privateKeyPublic = createPublicKey(keyRotated.key).export({ format: 'der', type: 'spki' });
  assert.deepEqual(certificateKey, privateKeyPublic);
  await assertCredentialsStartTls(keyRotated);
});

test('runtime HTTPS requires normal PKI trust or an explicit CA', async (t) => {
  const originalHome = process.env.HOME;
  const originalRuntimeUrl = process.env.HCC_RUNTIME_URL;
  const originalRuntimeToken = process.env.HCC_RUNTIME_TOKEN;
  const originalRuntimeCa = process.env.HCC_RUNTIME_CA;
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-runtime-ca-'));
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalRuntimeUrl === undefined) delete process.env.HCC_RUNTIME_URL;
    else process.env.HCC_RUNTIME_URL = originalRuntimeUrl;
    if (originalRuntimeToken === undefined) delete process.env.HCC_RUNTIME_TOKEN;
    else process.env.HCC_RUNTIME_TOKEN = originalRuntimeToken;
    if (originalRuntimeCa === undefined) delete process.env.HCC_RUNTIME_CA;
    else process.env.HCC_RUNTIME_CA = originalRuntimeCa;
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  });

  process.env.HOME = runtimeHome;
  const credentials = webTls.ensureSelfSignedCert();
  const server = https.createServer({ key: credentials.key, cert: credentials.cert }, (_req, res) => res.end('tls-ok'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const runtime = { base_url: `https://localhost:${server.address().port}` };

  await assert.rejects(
    runtimeHttpRequest(runtime, '/probe', { timeoutMs: 3000 }),
    /self-signed certificate|unable to verify/i
  );
  const trusted = await runtimeHttpRequest({ ...runtime, tls_ca: credentials.cert }, '/probe', { timeoutMs: 3000 });
  assert.equal(trusted.ok, true);
  assert.equal(trusted.text, 'tls-ok');

  const caFile = path.join(runtimeHome, 'runtime-ca.pem');
  fs.writeFileSync(caFile, credentials.cert, { mode: 0o600 });
  process.env.HCC_RUNTIME_URL = runtime.base_url;
  process.env.HCC_RUNTIME_TOKEN = 'runtime-token';
  process.env.HCC_RUNTIME_CA = caFile;
  const fromEnvironment = readRuntime({ root: runtimeHome });
  const fileTrusted = await runtimeHttpRequest(fromEnvironment, '/probe', { timeoutMs: 3000 });
  assert.equal(fileTrusted.ok, true);
  assert.equal(fileTrusted.text, 'tls-ok');
});
