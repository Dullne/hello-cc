import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPublicKey, X509Certificate } from 'node:crypto';
import * as webTls from '../lib/web/tls.mjs';
import { readRuntime } from '../lib/runtime/state.mjs';
import { runtimeHttpRequest } from '../lib/web/runtime.mjs';

function currentGeneration(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.hello-cc', 'tls', 'current.json'), 'utf8')).generation;
}

function tlsDirectory(home) {
  return path.join(home, '.hello-cc', 'tls');
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

test('preexisting redirected or writable TLS state is never reused or chmoded through a link', async (t) => {
  const originalHome = process.env.HOME;
  const homes = [];
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  });
  const makeHome = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-tls-leaf-'));
    homes.push(home);
    return home;
  };
  const original = makeHome();
  process.env.HOME = original;
  const trusted = webTls.ensureSelfSignedCert();
  const trustedGeneration = currentGeneration(original);

  const cases = [
    {
      name: 'current pointer symlink',
      alter(home, dir) {
        const pointer = path.join(dir, 'current.json');
        const outside = path.join(home, 'outside-pointer.json');
        const originalPointer = fs.readFileSync(pointer, 'utf8');
        fs.writeFileSync(outside, originalPointer, { mode: 0o644 });
        fs.chmodSync(outside, 0o644);
        fs.unlinkSync(pointer);
        fs.symlinkSync(outside, pointer);
        return () => {
          assert.equal(fs.readFileSync(outside, 'utf8'), originalPointer);
          assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
        };
      }
    },
    {
      name: 'group-writable current pointer',
      alter(_home, dir) {
        fs.chmodSync(path.join(dir, 'current.json'), 0o660);
      }
    },
    {
      name: 'current pointer hardlink',
      alter(home, dir) {
        const pointer = path.join(dir, 'current.json');
        const outside = path.join(home, 'outside-pointer.json');
        const originalPointer = fs.readFileSync(pointer, 'utf8');
        fs.renameSync(pointer, outside);
        fs.linkSync(outside, pointer);
        fs.chmodSync(outside, 0o644);
        return () => {
          assert.equal(fs.readFileSync(outside, 'utf8'), originalPointer);
          assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
        };
      }
    },
    {
      name: 'generation directory symlink',
      alter(home, dir) {
        const generationDir = path.join(dir, trustedGeneration);
        const outside = path.join(home, 'outside-generation');
        fs.renameSync(generationDir, outside);
        fs.chmodSync(outside, 0o755);
        fs.symlinkSync(outside, generationDir, 'dir');
        return () => {
          assert.equal(fs.statSync(outside).mode & 0o777, 0o755);
          assert.equal(fs.readFileSync(path.join(outside, 'self-signed.key'), 'utf8'), trusted.key);
        };
      }
    },
    {
      name: 'group-writable generation directory',
      alter(_home, dir) {
        const generationDir = path.join(dir, trustedGeneration);
        fs.chmodSync(generationDir, 0o770);
        return () => assert.equal(fs.statSync(generationDir).mode & 0o777, 0o770);
      }
    },
    ...['key', 'crt'].flatMap((extension) => [
      {
        name: `${extension} symlink`,
        alter(home, dir) {
          const leaf = path.join(dir, trustedGeneration, `self-signed.${extension}`);
          const outside = path.join(home, `outside-${extension}`);
          const content = fs.readFileSync(leaf, 'utf8');
          fs.writeFileSync(outside, content, { mode: 0o644 });
          fs.chmodSync(outside, 0o644);
          fs.unlinkSync(leaf);
          fs.symlinkSync(outside, leaf);
          return () => {
            assert.equal(fs.readFileSync(outside, 'utf8'), content);
            assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
          };
        }
      },
      {
        name: `group-writable ${extension}`,
        alter(_home, dir) {
          const leaf = path.join(dir, trustedGeneration, `self-signed.${extension}`);
          fs.chmodSync(leaf, 0o660);
          return () => assert.equal(fs.statSync(leaf).mode & 0o777, 0o660);
        }
      },
      {
        name: `${extension} hardlink`,
        alter(home, dir) {
          const leaf = path.join(dir, trustedGeneration, `self-signed.${extension}`);
          const outside = path.join(home, `outside-${extension}`);
          const content = fs.readFileSync(leaf, 'utf8');
          fs.renameSync(leaf, outside);
          fs.linkSync(outside, leaf);
          fs.chmodSync(outside, 0o644);
          return () => {
            assert.equal(fs.readFileSync(outside, 'utf8'), content);
            assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
          };
        }
      }
    ])
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const home = makeHome();
      fs.mkdirSync(path.join(home, '.hello-cc'), { mode: 0o700 });
      fs.cpSync(tlsDirectory(original), tlsDirectory(home), { recursive: true });
      process.env.HOME = home;
      assert.equal(webTls.ensureSelfSignedCert().cert, trusted.cert, 'unmodified generated identity changed');
      const checkExternal = fixture.alter(home, tlsDirectory(home));
      const replacement = webTls.ensureSelfSignedCert();
      assert.notEqual(replacement.cert, trusted.cert, `${fixture.name} reused an unsafe identity`);
      assert.notEqual(currentGeneration(home), trustedGeneration);
      checkExternal?.();
      await assertCredentialsStartTls(replacement);
    });
  }
});

test('legacy private TLS pair migrates without rotation, but an unsafe pair does not', async (t) => {
  const originalHome = process.env.HOME;
  const homes = [];
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  });
  const makeHome = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-tls-legacy-'));
    homes.push(home);
    fs.mkdirSync(tlsDirectory(home), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(home, '.hello-cc'), 0o700);
    return home;
  };
  const sourceHome = makeHome();
  process.env.HOME = sourceHome;
  const source = webTls.ensureSelfSignedCert();

  const safeHome = makeHome();
  fs.writeFileSync(path.join(tlsDirectory(safeHome), 'self-signed.key'), source.key, { mode: 0o600 });
  fs.writeFileSync(path.join(tlsDirectory(safeHome), 'self-signed.crt'), source.cert, { mode: 0o600 });
  process.env.HOME = safeHome;
  const migrated = webTls.ensureSelfSignedCert();
  assert.equal(migrated.cert, source.cert);
  assert.equal(webTls.ensureSelfSignedCert().cert, source.cert);
  await assertCredentialsStartTls(migrated);

  const unsafeHome = makeHome();
  const outside = path.join(unsafeHome, 'outside-key');
  fs.writeFileSync(outside, source.key, { mode: 0o644 });
  fs.chmodSync(outside, 0o644);
  fs.symlinkSync(outside, path.join(tlsDirectory(unsafeHome), 'self-signed.key'));
  fs.writeFileSync(path.join(tlsDirectory(unsafeHome), 'self-signed.crt'), source.cert, { mode: 0o600 });
  process.env.HOME = unsafeHome;
  const rotated = webTls.ensureSelfSignedCert();
  assert.notEqual(rotated.cert, source.cert);
  assert.equal(fs.readFileSync(outside, 'utf8'), source.key);
  assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
  await assertCredentialsStartTls(rotated);
});

test('preexisting FIFO pointer or key cannot block TLS startup', (t) => {
  const originalHome = process.env.HOME;
  const homes = [];
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  });
  const moduleUrl = new URL('../lib/web/tls.mjs', import.meta.url).href;
  for (const leaf of ['current.json', 'self-signed.key']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-tls-fifo-'));
    homes.push(home);
    process.env.HOME = home;
    webTls.ensureSelfSignedCert();
    const oldGeneration = currentGeneration(home);
    const fifoPath = leaf === 'current.json'
      ? path.join(tlsDirectory(home), leaf)
      : path.join(tlsDirectory(home), oldGeneration, leaf);
    fs.unlinkSync(fifoPath);
    const mkfifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
    if (mkfifo.error?.code === 'ENOENT') {
      t.skip('mkfifo is unavailable');
      return;
    }
    assert.equal(mkfifo.status, 0, mkfifo.stderr || mkfifo.error?.message);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { ensureSelfSignedCert } from ${JSON.stringify(moduleUrl)}; ensureSelfSignedCert();`], {
      env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 5000
    });
    assert.equal(child.status, 0, `${leaf}: ${child.error?.message || child.stderr}`);
    assert.notEqual(currentGeneration(home), oldGeneration, `${leaf} was treated as reusable`);
  }
});

test('untrusted generation markers cannot rewrite files outside TLS', (t) => {
  const originalHome = process.env.HOME;
  const homes = [];
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  });
  for (const marker of ['.creating', '.published']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-tls-marker-'));
    homes.push(home);
    process.env.HOME = home;
    const initial = webTls.ensureSelfSignedCert();
    const generationDir = path.join(tlsDirectory(home), currentGeneration(home));
    fs.unlinkSync(path.join(generationDir, '.published'));
    const outside = path.join(home, 'outside-marker');
    fs.writeFileSync(outside, 'unchanged\n', { mode: 0o644 });
    fs.chmodSync(outside, 0o644);
    fs.symlinkSync(outside, path.join(generationDir, marker));
    const reused = webTls.ensureSelfSignedCert();
    assert.equal(reused.cert, initial.cert, `${marker} changed a valid certificate`);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged\n');
    assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
  }
});

test('cleanup keeps a generation when current.json changes during its checked read', (t) => {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-tls-cleanup-'));
  process.env.HOME = home;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const credentials = webTls.ensureSelfSignedCert();
  const dir = tlsDirectory(home);
  const current = currentGeneration(home);
  const initialDirectory = path.join(dir, current);
  const previous = 'generation-test-previous';
  const switched = 'generation-test-switched';
  for (const [name, ageMs] of [[previous, 5 * 60 * 1000], [switched, 90 * 60 * 1000]]) {
    const generationDir = path.join(dir, name);
    fs.mkdirSync(generationDir, { mode: 0o700 });
    for (const extension of ['key', 'crt']) {
      fs.copyFileSync(path.join(initialDirectory, `self-signed.${extension}`),
        path.join(generationDir, `self-signed.${extension}`));
    }
    fs.writeFileSync(path.join(generationDir, '.published'), `${process.pid}\n`, { mode: 0o600 });
    const modifiedAt = new Date(Date.now() - ageMs);
    fs.utimesSync(generationDir, modifiedAt, modifiedAt);
  }

  const pointer = path.join(dir, 'current.json');
  const pointerStat = fs.statSync(pointer);
  const replacement = path.join(dir, '.current-test-switch.tmp');
  fs.writeFileSync(replacement, `${JSON.stringify({ generation: switched })}\n`, { mode: 0o600 });
  const originalRead = fs.readFileSync;
  let pointerReads = 0;
  try {
    fs.readFileSync = (file, ...args) => {
      const isPointer = typeof file === 'number' &&
        fs.fstatSync(file).dev === pointerStat.dev && fs.fstatSync(file).ino === pointerStat.ino;
      const result = originalRead(file, ...args);
      if (isPointer && ++pointerReads === 3) fs.renameSync(replacement, pointer);
      return result;
    };
    assert.equal(webTls.ensureSelfSignedCert().cert, credentials.cert);
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(pointerReads >= 3, true, 'cleanup did not reach the deletion-time pointer check');
  assert.equal(currentGeneration(home), switched);
  assert.equal(fs.existsSync(path.join(dir, switched)), true, 'new current generation was deleted');
  assert.equal(fs.existsSync(path.join(dir, previous)), true, 'previous generation was deleted');
});

test('cleanup rechecks a pointer switched just before its deletion guard', (t) => {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-tls-guard-'));
  process.env.HOME = home;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const credentials = webTls.ensureSelfSignedCert();
  const dir = tlsDirectory(fs.realpathSync(home));
  const initialDirectory = path.join(dir, currentGeneration(home));
  const previous = 'generation-test-previous';
  const switched = 'generation-test-switched';
  for (const [name, ageMs] of [[previous, 5 * 60 * 1000], [switched, 90 * 60 * 1000]]) {
    const generationDir = path.join(dir, name);
    fs.mkdirSync(generationDir, { mode: 0o700 });
    for (const extension of ['key', 'crt']) {
      fs.copyFileSync(path.join(initialDirectory, `self-signed.${extension}`),
        path.join(generationDir, `self-signed.${extension}`));
    }
    fs.writeFileSync(path.join(generationDir, '.published'), `${process.pid}\n`, { mode: 0o600 });
    const modifiedAt = new Date(Date.now() - ageMs);
    fs.utimesSync(generationDir, modifiedAt, modifiedAt);
  }
  const pointer = path.join(dir, 'current.json');
  const originalLstat = fs.lstatSync;
  let pointerChecks = 0;
  try {
    fs.lstatSync = (file, ...args) => {
      if (path.resolve(String(file)) === path.resolve(pointer) && ++pointerChecks === 5) {
        const replacement = path.join(dir, '.current-test-switch.tmp');
        fs.writeFileSync(replacement, `${JSON.stringify({ generation: switched })}\n`, { mode: 0o600 });
        fs.renameSync(replacement, pointer);
      }
      return originalLstat(file, ...args);
    };
    assert.equal(webTls.ensureSelfSignedCert().cert, credentials.cert);
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(pointerChecks >= 6, true, `cleanup did not reach the deletion-time pointer check (${pointerChecks})`);
  assert.equal(currentGeneration(home), switched);
  assert.equal(fs.existsSync(path.join(dir, switched)), true, 'new current generation was deleted');
  assert.equal(fs.existsSync(path.join(dir, previous)), true, 'previous generation was deleted');
});

test('cleanup retains previous, recent, and active generations but removes stale dead creation', (t) => {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-tls-lifecycle-'));
  process.env.HOME = home;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const credentials = webTls.ensureSelfSignedCert();
  const dir = tlsDirectory(home);
  const initial = currentGeneration(home);
  const fixtures = [
    { name: 'generation-test-previous', ageMs: 5 * 60 * 1000, complete: true, marker: '.published', pid: process.pid },
    { name: 'generation-test-recent', ageMs: 30 * 60 * 1000 },
    { name: 'generation-test-active', ageMs: 2 * 60 * 60 * 1000, marker: '.creating', pid: process.pid },
    { name: 'generation-test-dead', ageMs: 3 * 60 * 60 * 1000, marker: '.creating', pid: 99999999 }
  ];
  for (const fixture of fixtures) {
    const generationDir = path.join(dir, fixture.name);
    fs.mkdirSync(generationDir, { mode: 0o700 });
    if (fixture.complete) {
      for (const extension of ['key', 'crt']) {
        fs.copyFileSync(path.join(dir, initial, `self-signed.${extension}`),
          path.join(generationDir, `self-signed.${extension}`));
      }
    }
    if (fixture.marker) {
      fs.writeFileSync(path.join(generationDir, fixture.marker), `${fixture.pid}\n`, { mode: 0o600 });
    }
    const modifiedAt = new Date(Date.now() - fixture.ageMs);
    fs.utimesSync(generationDir, modifiedAt, modifiedAt);
  }
  assert.equal(webTls.ensureSelfSignedCert().cert, credentials.cert);
  assert.equal(currentGeneration(home), initial);
  for (const fixture of fixtures) {
    assert.equal(fs.existsSync(path.join(dir, fixture.name)), fixture.name !== 'generation-test-dead', fixture.name);
  }
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
