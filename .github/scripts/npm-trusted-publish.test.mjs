import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const helper = new URL('./npm-trusted-publish.mjs', import.meta.url);
const packageName = '@logicseek/hello-cc';
const repository = { type: 'git', url: 'git+https://github.com/Dullne/hello-cc.git' };
const manual = { GITHUB_REPOSITORY: 'Dullne/hello-cc', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/master', INPUT_VERSION: '1.2.1' };
const sha = (bytes, algorithm) => createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');

function archive(metadata) {
  const content = Buffer.from(JSON.stringify(metadata)), header = Buffer.alloc(512);
  header.write('package/package.json'); header.write('0000644\0', 100); header.write('0000000\0', 108);
  header.write('0000000\0', 116); header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write('0', 156);
  header.write('ustar\0', 257); header.write('00', 263);
  header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024)]));
}

function fixture(t, metadata = { name: packageName, version: '1.2.1', repository }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-npm-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'docs', 'verification'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: packageName, version: '1.2.1', repository }));
  const bytes = archive(metadata), filename = 'logicseek-hello-cc-1.2.1.tgz';
  const manifest = { version: '1.2.1', filename, tag: 'latest', sha256: sha(bytes, 'sha256'),
    shasum: sha(bytes, 'sha1'), integrity: 'sha512-' + sha(bytes, 'sha512') };
  const manifestFile = path.join(directory, 'dsh-1.2.1-package.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest)); fs.writeFileSync(path.join(directory, filename), bytes);
  return { root, bytes, manifest, manifestFile, tarball: path.join(directory, filename) };
}

test('trusted publishing has a dedicated frozen-archive preflight', () => {
  assert.equal(fs.existsSync(helper), true, 'Trusted publishing must validate the frozen archive before invoking npm');
});

test('prepare validates the actual tar member and all three archive digests for manual and tag runs', async t => {
  const { prepare } = await import(helper), f = fixture(t);
  for (const env of [manual, { ...manual, INPUT_VERSION: 'v1.2.1' },
    { ...manual, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.2.1', INPUT_VERSION: '' }]) {
    const result = prepare({ root: f.root, env });
    assert.equal(result.version, '1.2.1');
    assert.equal(result.tarball, 'docs/verification/logicseek-hello-cc-1.2.1.tgz');
    assert.equal(result.integrity, f.manifest.integrity);
    assert.equal(result.sha256, f.manifest.sha256);
  }
});

test('untrusted repositories, refs, events and malformed or mismatched versions are rejected', async t => {
  const { prepare } = await import(helper), f = fixture(t);
  for (const changes of [{ GITHUB_REPOSITORY: 'fork/hello-cc' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/other' }, { INPUT_VERSION: '1.2.0' }, { INPUT_VERSION: '../1.2.1' },
    { INPUT_VERSION: '1.2.1\nmalicious=value' }, { INPUT_VERSION: '' },
    { INPUT_VERSION: 'vv1.2.1' },
    { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/master' },
    { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.2.0' }]) {
    assert.throws(() => prepare({ root: f.root, env: { ...manual, ...changes } }));
  }
});

test('unsafe filenames/tags and each mismatched archive digest fail closed', async t => {
  const { prepare } = await import(helper), f = fixture(t);
  for (const changes of [{ filename: '../outside.tgz' }, { filename: 'x\noutput=bad.tgz' },
    { filename: 'other.tgz' }, { tag: '--access=restricted' }, { tag: 'bad\nlatest' },
    { version: '1.2.0' }, { sha256: '0'.repeat(64) }, { shasum: '0'.repeat(40) },
    { integrity: 'sha512-' + Buffer.alloc(64).toString('base64') }]) {
    fs.writeFileSync(f.manifestFile, JSON.stringify({ ...f.manifest, ...changes }));
    assert.throws(() => prepare({ root: f.root, env: manual }));
  }
});

test('an archive with valid checksums but the wrong package identity is rejected', async t => {
  const { prepare } = await import(helper);
  for (const metadata of [{ name: '@other/package', version: '1.2.1' }, { name: packageName, version: '1.2.0' }]) {
    const f = fixture(t, metadata);
    assert.throws(() => prepare({ root: f.root, env: manual }));
  }
});

test('source and archived metadata must identify the canonical GitHub repository', async t => {
  const { prepare } = await import(helper), wrongRepository = { type: 'git', url: 'git+https://github.com/fork/hello-cc.git' };
  const source = fixture(t);
  fs.writeFileSync(path.join(source.root, 'package.json'), JSON.stringify({ name: packageName, version: '1.2.1', repository: wrongRepository }));
  assert.throws(() => prepare({ root: source.root, env: manual }), /repository/i);
  const packed = fixture(t, { name: packageName, version: '1.2.1', repository: wrongRepository });
  assert.throws(() => prepare({ root: packed.root, env: manual }), /repository/i);
});

const present = artifact => new Response(JSON.stringify({ name: packageName, version: artifact.version,
  dist: { integrity: artifact.integrity, shasum: artifact.shasum } }), { status: 200 });
const absent = () => new Response('{}', { status: 404 });
const pause = async () => {};
function fakeClock() {
  let elapsed = 0;
  const sleeps = [];
  return { now: () => elapsed, pause: async milliseconds => { sleeps.push(milliseconds); elapsed += milliseconds; },
    advance: milliseconds => { elapsed += milliseconds; }, sleeps };
}

test('matching registry metadata is idempotent and never invokes npm', async t => {
  const { prepare, publish } = await import(helper), artifact = prepare({ root: fixture(t).root, env: manual });
  let calls = 0;
  const result = await publish(artifact, { fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://registry.npmjs.org/@logicseek%2fhello-cc/1.2.1');
    assert.equal(options.redirect, 'error'); assert.ok(options.signal); return present(artifact);
  }, execute: () => assert.fail('Existing matching version must not be published'), pause });
  assert.equal(result.published, false); assert.equal(calls, 1);
});

test('different or incomplete registry checksums, non-404 errors and malformed data never publish', async t => {
  const { prepare, publish } = await import(helper), artifact = prepare({ root: fixture(t).root, env: manual });
  for (const response of [new Response('{}', { status: 503 }), new Response('{}', { status: 401 }),
    new Response('not json'), new Response(JSON.stringify({ name: packageName, version: '1.2.1', dist: {} })),
    new Response(JSON.stringify({ name: packageName, version: '1.2.1', dist: { integrity: artifact.integrity, shasum: '0'.repeat(40) } }))]) {
    await assert.rejects(publish(artifact, { fetchImpl: async () => response,
      execute: () => assert.fail('Unsafe registry response must not publish'), pause }));
  }
});

test('only a confirmed absent version publishes the exact frozen archive and polls readback', async t => {
  const { prepare, publish } = await import(helper), artifact = prepare({ root: fixture(t).root, env: manual });
  let reads = 0, executions = 0;
  const result = await publish(artifact, { fetchImpl: async () => ++reads < 3 ? absent() : present(artifact), pause, log: () => {},
    execute: (file, args, options) => {
      executions++; assert.equal(file, 'npm');
      assert.deepEqual(args, ['publish', artifact.tarball, '--access', 'public', '--tag', 'latest', '--ignore-scripts',
        '--registry', 'https://registry.npmjs.org']);
      assert.equal(options.cwd, artifact.root); assert.equal(options.timeout, 120000);
      assert.equal(options.stdio, 'inherit'); assert.equal(options.shell, false);
    } });
  assert.equal(result.published, true); assert.equal(reads, 3); assert.equal(executions, 1);
});

test('network failures are bounded and npm failure is preserved', async t => {
  const { prepare, publish } = await import(helper), artifact = prepare({ root: fixture(t).root, env: manual });
  let attempts = 0;
  await assert.rejects(publish(artifact, { fetchImpl: async () => { attempts++; throw new Error('network unavailable'); },
    execute: () => assert.fail('Unknown registry state must not publish'), pause }));
  assert.equal(attempts, 3);
  const original = Object.assign(new Error('npm rejected publication'), { status: 17 });
  await assert.rejects(publish(artifact, { fetchImpl: async () => absent(), pause, execute: () => { throw original; } }),
    error => error === original);
});

test('accepted upload waits several minutes for registry processing without publishing again', async t => {
  const { prepare, publish } = await import(helper), artifact = prepare({ root: fixture(t).root, env: manual });
  const clock = fakeClock(), statuses = [];
  let executions = 0;
  const result = await publish(artifact, { ...clock, log: message => statuses.push(message),
    fetchImpl: async () => clock.now() < 240000 ? absent() : present(artifact),
    execute: () => { executions++; } });
  assert.equal(result.verified, true);
  assert.equal(executions, 1);
  assert.equal(clock.now(), 240000);
  assert.ok(clock.sleeps.every(milliseconds => milliseconds === 10000));
  assert.equal(statuses.length, 2);
  assert.match(statuses[0], /upload accepted.*registry confirmation pending/i);
  assert.match(statuses[1], /registry confirmed.*frozen checksums/i);
});

test('ten-minute confirmation timeout distinguishes accepted upload from verify-only mode', async t => {
  const { prepare, publish, verify } = await import(helper), artifact = prepare({ root: fixture(t).root, env: manual });
  for (const uploaded of [true, false]) {
    const clock = fakeClock(); let executions = 0, reads = 0;
    const options = { ...clock, log: () => {}, fetchImpl: async () => { reads++; return absent(); },
      execute: () => { executions++; } };
    await assert.rejects((uploaded ? publish : verify)(artifact, options), error => {
      assert.equal(error.code, 'NPM_REGISTRY_CONFIRMATION_PENDING');
      assert.match(error.message, /registry confirmation.*pending/i);
      if (uploaded) assert.match(error.message, /upload accepted/i);
      else assert.doesNotMatch(error.message, /upload accepted/i);
      return true;
    });
    assert.equal(clock.now(), 600000);
    assert.equal(executions, uploaded ? 1 : 0);
    assert.equal(reads, uploaded ? 61 : 60);
  }
});

test('request and retry waits consume only the remaining confirmation window', async t => {
  const { prepare, verify } = await import(helper), artifact = prepare({ root: fixture(t).root, env: manual });
  const clock = fakeClock(), budgets = [], original = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', milliseconds => { budgets.push(milliseconds); return original(milliseconds); });
  let requests = 0;
  await assert.rejects(verify(artifact, { ...clock, log: () => {}, fetchImpl: async () => {
    requests++;
    if (requests === 1) { clock.advance(588500); return absent(); }
    if (requests === 2) { clock.advance(750); throw new Error('network unavailable'); }
    assert.fail('A retry must not start after the overall deadline');
  } }), error => error.code === 'NPM_REGISTRY_CONFIRMATION_PENDING');
  assert.equal(clock.now(), 600000);
  assert.deepEqual(budgets, [10000, 1500]);
  assert.deepEqual(clock.sleeps, [10000, 750]);
});

test('a response body completing at the deadline cannot report late confirmation', async t => {
  const { prepare, verify } = await import(helper), artifact = prepare({ root: fixture(t).root, env: manual });
  const clock = fakeClock();
  await assert.rejects(verify(artifact, { ...clock, log: () => {}, fetchImpl: async () => ({ status: 200,
    json: async () => { clock.advance(600000); return { name: packageName, version: artifact.version,
      dist: { integrity: artifact.integrity, shasum: artifact.shasum } }; } }) }),
  error => error.code === 'NPM_REGISTRY_CONFIRMATION_PENDING');
});

test('malformed registry data remains an error even when parsing reaches the deadline', async t => {
  const { prepare, verify } = await import(helper), artifact = prepare({ root: fixture(t).root, env: manual });
  const clock = fakeClock(), malformed = new SyntaxError('Invalid registry JSON');
  await assert.rejects(verify(artifact, { ...clock, log: () => {}, fetchImpl: async () => ({ status: 200,
    json: async () => { clock.advance(600000); throw malformed; } }) }), error => error === malformed);
});

test('the remaining-window abort also bounds a real slow HTTP response body', { timeout: 5000 }, async t => {
  const { prepare, verify } = await import(helper), artifact = prepare({ root: fixture(t).root, env: manual });
  let responses = 0, slowBody;
  const server = http.createServer((_request, response) => {
    responses++; response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders();
    slowBody = setTimeout(() => response.end('{}'), 2000);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { clearTimeout(slowBody); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const began = performance.now(); let firstClockRead = true;
  const now = () => {
    if (firstClockRead) { firstClockRead = false; return 0; }
    return 599800 + performance.now() - began;
  };
  await assert.rejects(verify(artifact, { now, log: () => {},
    fetchImpl: (_url, options) => fetch(`http://127.0.0.1:${server.address().port}/slow`, options) }),
  error => error.code === 'NPM_REGISTRY_CONFIRMATION_PENDING');
  assert.equal(responses, 1);
  assert.ok(performance.now() - began < 1500, 'Body read escaped the remaining confirmation window');
});

test('readback rejects identity or digest conflicts and non-404 errors immediately', async t => {
  const { prepare, verify } = await import(helper), artifact = prepare({ root: fixture(t).root, env: manual });
  for (const response of [new Response('{}', { status: 503 }),
    new Response(JSON.stringify({ name: packageName, version: '9.9.9', dist: {} })),
    new Response(JSON.stringify({ name: packageName, version: artifact.version,
      dist: { integrity: 'different', shasum: artifact.shasum } }))]) {
    const clock = fakeClock(); let calls = 0;
    await assert.rejects(verify(artifact, { ...clock, log: () => {}, fetchImpl: async () => { calls++; return response; } }));
    assert.equal(calls, 1); assert.equal(clock.now(), 0); assert.deepEqual(clock.sleeps, []);
  }
});

test('the real prepare CLI emits safe GitHub outputs without network or npm publication', async t => {
  const f = fixture(t), output = path.join(f.root, 'github-output');
  const result = spawnSync(process.execPath, [fileURLToPath(helper), 'prepare'], {
    cwd: f.root, env: { ...process.env, ...manual, GITHUB_OUTPUT: output }, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(output, 'utf8'), `version=1.2.1\ntarball=docs/verification/logicseek-hello-cc-1.2.1.tgz\nintegrity=${f.manifest.integrity}\n`);
  assert.equal(JSON.parse(result.stdout).version, '1.2.1');
});
