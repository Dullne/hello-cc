import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const name = '@logicseek/hello-cc', registry = 'https://registry.npmjs.org';
const repository = 'git+https://github.com/Dullne/hello-cc.git';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
const digest = (bytes, algorithm) => createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');

function regularFile(root, relative) {
  const file = path.join(root, relative);
  assert.equal(fs.realpathSync(file), file, 'Release inputs must not redirect');
  assert.ok(fs.lstatSync(file).isFile(), 'Release inputs must be regular files');
  return file;
}

function assertArchive(artifact) {
  const bytes = fs.readFileSync(regularFile(artifact.root, artifact.tarball));
  assert.equal(digest(bytes, 'sha256'), artifact.sha256, 'Frozen archive SHA256 mismatch');
  assert.equal(digest(bytes, 'sha1'), artifact.shasum, 'Frozen archive SHA1 mismatch');
  assert.equal('sha512-' + digest(bytes, 'sha512'), artifact.integrity, 'Frozen archive SHA512 mismatch');
}

export function prepare({ root = process.cwd(), env = process.env } = {}) {
  root = fs.realpathSync(root);
  assert.equal(env.GITHUB_REPOSITORY, 'Dullne/hello-cc', 'Only the canonical repository can publish');
  const metadata = JSON.parse(fs.readFileSync(regularFile(root, 'package.json'), 'utf8'));
  assert.equal(metadata.name, name, 'Unexpected package name');
  assert.equal(metadata.repository?.url, repository, 'Source repository must be canonical');
  assert.ok(typeof metadata.version === 'string' && versionPattern.test(metadata.version), 'Invalid package version');
  const manual = env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/master';
  const tagged = env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === `refs/tags/v${metadata.version}`;
  assert.ok(manual || tagged, 'Publishing requires a manual master run or the exact version tag');
  if (manual) assert.equal(env.INPUT_VERSION?.replace(/^v/, ''), metadata.version, 'Requested version must match package.json');
  const manifest = JSON.parse(fs.readFileSync(regularFile(root, `docs/verification/dsh-${metadata.version}-package.json`), 'utf8'));
  assert.equal(manifest.version, metadata.version, 'Frozen manifest version mismatch');
  if (manifest.name !== undefined) assert.equal(manifest.name, name, 'Frozen manifest package mismatch');
  assert.equal(manifest.filename, `logicseek-hello-cc-${metadata.version}.tgz`, 'Archive must have the exact release basename');
  assert.ok(typeof manifest.tag === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(manifest.tag), 'Invalid npm distribution tag');
  const artifact = { root, version: metadata.version, tarball: `docs/verification/${manifest.filename}`,
    tag: manifest.tag, sha256: manifest.sha256, shasum: manifest.shasum, integrity: manifest.integrity };
  assertArchive(artifact);
  // Read the frozen member without extracting or repacking the release. Both
  // supported publishing runners provide tar; no package lifecycle runs here.
  const packed = JSON.parse(execFileSync('tar', ['-xOf', path.join(root, artifact.tarball), 'package/package.json'],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false }));
  assert.equal(packed.name, name, 'Frozen archive contains a different package');
  assert.equal(packed.version, metadata.version, 'Frozen archive contains a different version');
  assert.equal(packed.repository?.url, repository, 'Frozen archive repository must be canonical');
  return artifact;
}

function remaining(deadline, now) {
  const milliseconds = deadline - now();
  if (milliseconds <= 0) throw Object.assign(new Error('Registry readback deadline exceeded'), { code: 'NPM_READBACK_DEADLINE' });
  return milliseconds;
}

async function registryState(artifact, { fetchImpl = fetch, pause = delay, now = () => performance.now(), deadline = Infinity } = {}) {
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    const requestMs = Math.ceil(Math.min(10000, remaining(deadline, now)));
    try {
      response = await fetchImpl(`${registry}/@logicseek%2fhello-cc/${artifact.version}`, {
        headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(requestMs)
      });
      break;
    } catch {
      const rest = remaining(deadline, now);
      if (attempt === 2) throw new Error('Official npm registry could not be reached; registry status is unconfirmed');
      await pause(Math.min(1000, rest));
    }
  }
  remaining(deadline, now);
  if (response.status === 404) { await response.body?.cancel(); return false; }
  assert.equal(response.status, 200, `Official npm registry returned HTTP ${response.status}; cannot confirm the frozen version`);
  const published = await response.json();
  remaining(deadline, now);
  assert.equal(published.name, name, 'Registry package identity mismatch');
  assert.equal(published.version, artifact.version, 'Registry version identity mismatch');
  assert.equal(published.dist?.integrity, artifact.integrity, 'Published version has different or missing integrity; never overwrite it');
  assert.equal(published.dist?.shasum, artifact.shasum, 'Published version has different or missing shasum; never overwrite it');
  return true;
}

export async function verify(artifact, options = {}) {
  const pause = options.pause || delay, now = options.now || (() => performance.now());
  const deadline = now() + 10 * 60_000;
  try {
    while (now() < deadline) {
      if (await registryState(artifact, { ...options, now, deadline })) {
        (options.log || console.log)(`npm registry confirmed ${name}@${artifact.version} with the frozen checksums.`);
        return { verified: true, version: artifact.version, integrity: artifact.integrity };
      }
      await pause(Math.min(10000, remaining(deadline, now)));
    }
  } catch (error) {
    const deadlineAbort = now() >= deadline && ['AbortError', 'TimeoutError'].includes(error.name);
    if (error.code !== 'NPM_READBACK_DEADLINE' && !deadlineAbort) throw error;
  }
  const message = options.uploadAccepted
    ? 'npm upload accepted, but registry confirmation is still pending after the readback deadline. No upload was retried; use verify to check again.'
    : 'Registry confirmation is still pending after the readback deadline. This verification did not upload a package.';
  throw Object.assign(new Error(message), { code: 'NPM_REGISTRY_CONFIRMATION_PENDING', uploadAccepted: options.uploadAccepted === true });
}

export async function publish(artifact, options = {}) {
  if (await registryState(artifact, options)) return { published: false, verified: true, version: artifact.version, integrity: artifact.integrity };
  assertArchive(artifact);
  // npm obtains its short-lived OIDC credentials in the workflow. No login,
  // stored token, whoami precondition, lifecycle script or repack is involved.
  (options.execute || execFileSync)('npm', ['publish', artifact.tarball, '--access', 'public', '--tag', artifact.tag,
    '--ignore-scripts', '--registry', registry], { cwd: artifact.root, stdio: 'inherit', timeout: 120000, shell: false });
  (options.log || console.log)(`npm upload accepted for ${name}@${artifact.version}; registry confirmation pending.`);
  return { published: true, ...await verify(artifact, { ...options, uploadAccepted: true }) };
}

async function main() {
  const [mode, ...extra] = process.argv.slice(2);
  assert.ok(['prepare', 'publish', 'verify'].includes(mode) && extra.length === 0, 'Usage: npm-trusted-publish.mjs prepare|publish|verify');
  const artifact = prepare();
  if (mode === 'prepare') {
    const outputs = { version: artifact.version, tarball: artifact.tarball, integrity: artifact.integrity };
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
      Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(JSON.stringify({ ...outputs, sha256: artifact.sha256 }));
  } else console.log(JSON.stringify(await (mode === 'publish' ? publish(artifact) : verify(artifact))));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = Number.isInteger(error.status) && error.status > 0 ? error.status : 1; });
}
