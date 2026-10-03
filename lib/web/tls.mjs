import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createPublicKey, randomBytes, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { CliError } from '../shared/errors.mjs';
import { ensurePrivateGlobalSubdirectory } from '../runtime/private-state.mjs';
import { readPrivateTextFile } from '../runtime/private-file.mjs';
import { unsafeDirectoryAcl } from '../runtime/project-trust.mjs';

const CERT_RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
const GENERATION_CLEANUP_GRACE_MS = 60 * 60 * 1000;
const GENERATION_NAME_RE = /^generation-[a-z0-9-]+$/i;
const OWNED_GENERATION_NAME_RE = /^generation-[a-z0-9]+-(\d+)-[a-f0-9]+$/i;
const TLS_KEY_MAX_BYTES = 16384;
const TLS_CERT_MAX_BYTES = 65536;
const TLS_POINTER_MAX_BYTES = 16384;
const TLS_MARKER_MAX_BYTES = 128;

// hello-cc can serve the web console over HTTPS with an auto-generated
// self-signed certificate. This protects against passive LAN sniffing of the
// access token and terminal stream (net-02). The browser will warn about the
// self-signed cert until the user trusts it manually — that is the accepted
// tradeoff for not requiring a CA-signed cert.

function which(binary) {
  const result = spawnSync('which', [binary], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function opensslAvailable() {
  return Boolean(which('openssl'));
}

function hostSanEntry(host) {
  const value = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (!value || value === '0.0.0.0' || value === '::') return null;
  return isIP(value) ? `IP:${value}` : `DNS:${value}`;
}

function lanIpSanEntries(extraHosts = []) {
  const entries = ['DNS:localhost', 'IP:127.0.0.1', hostSanEntry(os.hostname())];
  for (const host of extraHosts) entries.push(hostSanEntry(host));
  try {
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      for (const addr of list || []) {
        if (addr.family === 'IPv4' && !addr.internal) entries.push(`IP:${addr.address}`);
      }
    }
  } catch {}
  // Dedup while preserving order.
  return [...new Set(entries.filter(Boolean))];
}

function generateCert(keyPath, certPath, sanEntries, configPath = null) {
  const args = [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '365', '-subj', '/CN=localhost'
  ];
  if (configPath) args.push('-config', configPath, '-extensions', 'v3_req');
  else args.push('-addext', `subjectAltName=${sanEntries.join(',')}`);
  return spawnSync('openssl', args, { encoding: 'utf8' });
}

function certificateCoversSans(certificate, sanEntries) {
  return sanEntries.every((entry) => {
    const separator = entry.indexOf(':');
    const type = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (type === 'DNS') return Boolean(certificate.checkHost(value, { subject: 'never' }));
    if (type === 'IP') return Boolean(certificate.checkIP(value));
    return false;
  });
}

function certificateMatchesKey(certificate, key) {
  const certPublicKey = certificate.publicKey.export({ format: 'der', type: 'spki' });
  const keyPublicKey = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return certPublicKey.equals(keyPublicKey);
}

export function tlsCredentialsAreReusable({ key, cert, sanEntries, nowMs = Date.now() }) {
  try {
    const certificate = new X509Certificate(cert);
    const validFromMs = Date.parse(certificate.validFrom);
    const validToMs = Date.parse(certificate.validTo);
    if (!Number.isFinite(nowMs) ||
        !Number.isFinite(validFromMs) ||
        !Number.isFinite(validToMs) ||
        validFromMs > nowMs ||
        validToMs <= nowMs + CERT_RENEW_BEFORE_MS) return false;
    return certificateCoversSans(certificate, sanEntries) &&
      certificateMatchesKey(certificate, key);
  } catch {
    return false;
  }
}

// The tls/ parent is validated before this module runs, but a generation may
// have been planted while an older installation still left that parent public.
// Do not follow or repair a foreign, redirected, or cross-UID-writable child.
function trustedTlsDirectory(directory, { tighten = false } = {}) {
  let fd;
  try {
    const before = fs.lstatSync(directory, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory() ||
        before.uid !== BigInt(process.getuid())) return null;
    fd = fs.openSync(directory, fs.constants.O_RDONLY |
      fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    let opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== before.uid || (opened.mode & 0o022n) !== 0n ||
        unsafeDirectoryAcl(directory, opened)) return null;
    if (tighten && (opened.mode & 0o777n) !== 0o700n) {
      fs.fchmodSync(fd, 0o700);
      opened = fs.fstatSync(fd, { bigint: true });
      if ((opened.mode & 0o777n) !== 0o700n) return null;
    }
    const after = fs.lstatSync(directory, { bigint: true });
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino ||
        after.uid !== opened.uid) return null;
    return opened;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readPrivateMarker(file) {
  try { return readPrivateTextFile(file, { maxBytes: TLS_MARKER_MAX_BYTES }); }
  catch { return null; }
}

function readReusableCredentials(keyPath, certPath, sanEntries) {
  try {
    if (!trustedTlsDirectory(path.dirname(keyPath), { tighten: true })) return null;
    const key = readPrivateTextFile(keyPath, { maxBytes: TLS_KEY_MAX_BYTES });
    const cert = readPrivateTextFile(certPath, { maxBytes: TLS_CERT_MAX_BYTES });
    if (key === null || cert === null) return null;
    if (!tlsCredentialsAreReusable({ key, cert, sanEntries })) return null;
    return { key, cert, certPath };
  } catch {
    return null;
  }
}

function opensslConfig(sanEntries) {
  return [
    '[req]',
    'distinguished_name = req_distinguished_name',
    'x509_extensions = v3_req',
    'prompt = no',
    '',
    '[req_distinguished_name]',
    'CN = localhost',
    '',
    '[v3_req]',
    `subjectAltName = ${sanEntries.join(',')}`,
    ''
  ].join('\n');
}

function generateCredentials(dir, keyPath, certPath, sanEntries) {
  if (!opensslAvailable()) {
    throw new CliError('TLS_UNAVAILABLE',
      'Cannot generate a self-signed TLS certificate: openssl is not installed. ' +
      'Install openssl, or run without --tls (prefer --local for loopback-only access).');
  }

  const suffix = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const tmpKeyPath = path.join(dir, `.self-signed.${suffix}.key.tmp`);
  const tmpCertPath = path.join(dir, `.self-signed.${suffix}.crt.tmp`);
  const tmpConfigPath = path.join(dir, `.self-signed.${suffix}.cnf.tmp`);
  try {
    let result = generateCert(tmpKeyPath, tmpCertPath, sanEntries);
    if (result.status !== 0) {
      try { fs.rmSync(tmpKeyPath, { force: true }); } catch {}
      try { fs.rmSync(tmpCertPath, { force: true }); } catch {}
      fs.writeFileSync(tmpConfigPath, opensslConfig(sanEntries), { mode: 0o600 });
      result = generateCert(tmpKeyPath, tmpCertPath, sanEntries, tmpConfigPath);
    }
    if (result.status !== 0) {
      throw new CliError('TLS_UNAVAILABLE',
        `Failed to generate a self-signed TLS certificate: ${(result.stderr || result.stdout || '').trim() || 'openssl exited with status ' + result.status}`);
    }

    try { fs.chmodSync(tmpKeyPath, 0o600); } catch {}
    try { fs.chmodSync(tmpCertPath, 0o600); } catch {}
    const generated = readReusableCredentials(tmpKeyPath, tmpCertPath, sanEntries);
    if (!generated) {
      throw new CliError('TLS_UNAVAILABLE', 'Generated TLS certificate failed validation');
    }

    // These files live in an unpublished generation directory. The generation
    // becomes active only after both renames and validation complete.
    fs.renameSync(tmpCertPath, certPath);
    fs.renameSync(tmpKeyPath, keyPath);
    return { key: generated.key, cert: generated.cert, certPath };
  } finally {
    for (const file of [tmpKeyPath, tmpCertPath, tmpConfigPath]) {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
}

function readCurrentGeneration(dir) {
  try {
    const text = readPrivateTextFile(path.join(dir, 'current.json'), {
      maxBytes: TLS_POINTER_MAX_BYTES
    });
    if (text === null) return null;
    const pointer = JSON.parse(text);
    const generation = String(pointer?.generation || '');
    return GENERATION_NAME_RE.test(generation) ? generation : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function generationCreationIsActive(generationDir, generation) {
  const creatingPath = path.join(generationDir, '.creating');
  const nameMatch = generation.match(OWNED_GENERATION_NAME_RE);
  const namePid = nameMatch ? Number.parseInt(nameMatch[1], 10) : null;
  try {
    const ownerPid = Number.parseInt(readPrivateMarker(creatingPath)?.trim(), 10);
    if (Number.isInteger(ownerPid) && ownerPid > 0 && (!namePid || ownerPid === namePid)) {
      return processIsAlive(ownerPid);
    }
  } catch {}
  if (readPrivateMarker(path.join(generationDir, '.published')) !== null) return false;

  // Backward compatibility for generations created before lifecycle markers
  // were added, including the mkdir-to-marker window in a concurrent creator.
  return namePid ? processIsAlive(namePid) : false;
}

function writeGenerationCreatingMarker(generationDir) {
  const markerPath = path.join(generationDir, '.creating');
  const tmpMarkerPath = path.join(generationDir, `.creating.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmpMarkerPath, `${process.pid}\n`, { mode: 0o600 });
    fs.renameSync(tmpMarkerPath, markerPath);
  } finally {
    try { fs.rmSync(tmpMarkerPath, { force: true }); } catch {}
  }
}

function markGenerationPublished(generationDir) {
  const creatingPath = path.join(generationDir, '.creating');
  const publishedPath = path.join(generationDir, '.published');
  if (readPrivateMarker(creatingPath) !== null) {
    try { fs.renameSync(creatingPath, publishedPath); return; } catch {}
  }
  if (readPrivateMarker(publishedPath) !== null) return;
  let fd;
  try {
    fd = fs.openSync(publishedPath, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, `${process.pid}\n`);
  } catch {
    // A bad preexisting marker must not block use of otherwise safe credentials.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function currentGenerationCredentials(dir, sanEntries) {
  try {
    const generation = readCurrentGeneration(dir);
    if (!generation) return null;
    const generationDir = path.join(dir, generation);
    const keyPath = path.join(generationDir, 'self-signed.key');
    const certPath = path.join(generationDir, 'self-signed.crt');
    const credentials = readReusableCredentials(keyPath, certPath, sanEntries);
    if (!credentials) return null;
    markGenerationPublished(generationDir);
    return credentials;
  } catch {
    return null;
  }
}

function publishGeneration(dir, generation) {
  const pointerPath = path.join(dir, 'current.json');
  const tmpPointerPath = path.join(dir, `.current.${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmpPointerPath, `${JSON.stringify({ generation })}\n`, { mode: 0o600 });
    fs.renameSync(tmpPointerPath, pointerPath);
  } finally {
    try { fs.rmSync(tmpPointerPath, { force: true }); } catch {}
  }
}

function pruneOldGenerations(dir, t = Date.now()) {
  try {
    const current = readCurrentGeneration(dir);
    if (!current) return;

    const generations = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && GENERATION_NAME_RE.test(entry.name))
      .map((entry) => {
        const stat = trustedTlsDirectory(path.join(dir, entry.name));
        return stat ? { name: entry.name, mtimeMs: Number(stat.mtimeMs), dev: stat.dev, ino: stat.ino } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    let keptPrevious = false;
    for (const generation of generations) {
      if (generation.name === current) continue;
      const generationDir = path.join(dir, generation.name);
      const hasCreatingMarker = readPrivateMarker(path.join(generationDir, '.creating')) !== null;
      if (generationCreationIsActive(generationDir, generation.name)) continue;
      let complete = false;
      try {
        const key = readPrivateTextFile(path.join(generationDir, 'self-signed.key'), {
          maxBytes: TLS_KEY_MAX_BYTES
        });
        const cert = readPrivateTextFile(path.join(generationDir, 'self-signed.crt'), {
          maxBytes: TLS_CERT_MAX_BYTES
        });
        complete = Boolean(key?.length && cert?.length);
      } catch {}
      if (!keptPrevious && complete && !hasCreatingMarker) {
        keptPrevious = true;
        continue;
      }
      // A concurrently generated directory may not be published yet. Leave
      // recent candidates alone; a later startup will collect stale losers.
      if (t - generation.mtimeMs < GENERATION_CLEANUP_GRACE_MS) continue;
      // current.json can change while this best-effort scan is running. An
      // unreadable or concurrently replaced pointer is not proof that this
      // generation is stale, so leave cleanup for a later startup.
      const latestCurrent = readCurrentGeneration(dir);
      if (!latestCurrent) return;
      if (latestCurrent === generation.name) continue;
      if (generationCreationIsActive(generationDir, generation.name)) continue;
      const beforeDelete = trustedTlsDirectory(generationDir);
      if (!beforeDelete || beforeDelete.dev !== generation.dev || beforeDelete.ino !== generation.ino) continue;
      try { fs.rmSync(generationDir, { recursive: true, force: true }); } catch {}
    }
  } catch {
    // Certificate cleanup is best-effort and must never prevent HTTPS startup.
  }
}

function createGeneration(dir, sanEntries, source = null) {
  const generation = `generation-${Date.now().toString(36)}-${process.pid}-${randomBytes(6).toString('hex')}`;
  const generationDir = path.join(dir, generation);
  const keyPath = path.join(generationDir, 'self-signed.key');
  const certPath = path.join(generationDir, 'self-signed.crt');
  fs.mkdirSync(generationDir, { mode: 0o700 });
  try {
    writeGenerationCreatingMarker(generationDir);
    let credentials;
    if (source) {
      fs.writeFileSync(keyPath, source.key, { mode: 0o600 });
      fs.writeFileSync(certPath, source.cert, { mode: 0o600 });
      credentials = readReusableCredentials(keyPath, certPath, sanEntries);
      if (!credentials) throw new CliError('TLS_UNAVAILABLE', 'Existing TLS credentials failed generation validation');
    } else {
      credentials = generateCredentials(generationDir, keyPath, certPath, sanEntries);
    }
    publishGeneration(dir, generation);
    markGenerationPublished(generationDir);
    pruneOldGenerations(dir);
    return credentials;
  } catch (err) {
    if (readCurrentGeneration(dir) !== generation) {
      try { fs.rmSync(generationDir, { recursive: true, force: true }); } catch {}
    }
    throw err;
  }
}

/**
 * Ensures a stable self-signed certificate exists under ~/.hello-cc/tls/ and
 * returns its PEM strings plus the cert path. Reused across restarts so the
 * browser trust decision is stable.
 */
export function ensureSelfSignedCert(extraHosts = []) {
  const dir = ensurePrivateGlobalSubdirectory('tls');
  const sanEntries = lanIpSanEntries(Array.isArray(extraHosts) ? extraHosts : [extraHosts]);

  const existing = currentGenerationCredentials(dir, sanEntries);
  if (existing) {
    pruneOldGenerations(dir);
    return existing;
  }

  // Migrate a valid legacy fixed pair without rotating its trust identity.
  const legacy = readReusableCredentials(
    path.join(dir, 'self-signed.key'),
    path.join(dir, 'self-signed.crt'),
    sanEntries
  );
  if (legacy) {
    return createGeneration(dir, sanEntries, legacy);
  }

  return createGeneration(dir, sanEntries);
}
