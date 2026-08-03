import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createPublicKey, randomBytes, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { CliError } from '../shared/errors.mjs';
import { globalStateDir } from '../runtime/paths.mjs';

const CERT_RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
const GENERATION_CLEANUP_GRACE_MS = 60 * 60 * 1000;
const GENERATION_NAME_RE = /^generation-[a-z0-9-]+$/i;
const OWNED_GENERATION_NAME_RE = /^generation-[a-z0-9]+-(\d+)-[a-f0-9]+$/i;

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

function readReusableCredentials(keyPath, certPath, sanEntries) {
  try {
    const key = fs.readFileSync(keyPath, 'utf8');
    const cert = fs.readFileSync(certPath, 'utf8');
    const certificate = new X509Certificate(cert);
    const nowMs = Date.now();
    const validFromMs = Date.parse(certificate.validFrom);
    const validToMs = Date.parse(certificate.validTo);
    if (!Number.isFinite(validFromMs) || !Number.isFinite(validToMs) ||
        validFromMs > nowMs || validToMs <= nowMs + CERT_RENEW_BEFORE_MS) return null;
    if (!certificateCoversSans(certificate, sanEntries)) return null;
    if (!certificateMatchesKey(certificate, key)) return null;
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
    const pointer = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8'));
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
    const ownerPid = Number.parseInt(fs.readFileSync(creatingPath, 'utf8').trim(), 10);
    if (Number.isInteger(ownerPid) && ownerPid > 0 && (!namePid || ownerPid === namePid)) {
      return processIsAlive(ownerPid);
    }
  } catch {}
  if (fs.existsSync(path.join(generationDir, '.published'))) return false;

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
  try {
    fs.renameSync(creatingPath, publishedPath);
  } catch {
    try { fs.writeFileSync(publishedPath, `${process.pid}\n`, { mode: 0o600 }); } catch {}
    if (fs.existsSync(publishedPath)) {
      try { fs.rmSync(creatingPath, { force: true }); } catch {}
    }
  }
  try { fs.chmodSync(publishedPath, 0o600); } catch {}
}

function currentGenerationCredentials(dir, sanEntries) {
  const pointerPath = path.join(dir, 'current.json');
  try {
    const generation = readCurrentGeneration(dir);
    if (!generation) return null;
    const generationDir = path.join(dir, generation);
    const keyPath = path.join(generationDir, 'self-signed.key');
    const certPath = path.join(generationDir, 'self-signed.crt');
    const credentials = readReusableCredentials(keyPath, certPath, sanEntries);
    if (!credentials) return null;
    try { fs.chmodSync(generationDir, 0o700); } catch {}
    try { fs.chmodSync(keyPath, 0o600); } catch {}
    try { fs.chmodSync(certPath, 0o600); } catch {}
    try { fs.chmodSync(pointerPath, 0o600); } catch {}
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
    try { fs.chmodSync(pointerPath, 0o600); } catch {}
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
        try {
          return { name: entry.name, mtimeMs: fs.statSync(path.join(dir, entry.name)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    let keptPrevious = false;
    for (const generation of generations) {
      if (generation.name === current) continue;
      const generationDir = path.join(dir, generation.name);
      const hasCreatingMarker = fs.existsSync(path.join(generationDir, '.creating'));
      if (generationCreationIsActive(generationDir, generation.name)) continue;
      let complete = false;
      try {
        complete = fs.statSync(path.join(generationDir, 'self-signed.key')).size > 0 &&
          fs.statSync(path.join(generationDir, 'self-signed.crt')).size > 0;
      } catch {}
      if (!keptPrevious && complete && !hasCreatingMarker) {
        keptPrevious = true;
        continue;
      }
      // A concurrently generated directory may not be published yet. Leave
      // recent candidates alone; a later startup will collect stale losers.
      if (t - generation.mtimeMs < GENERATION_CLEANUP_GRACE_MS) continue;
      // current.json can change while this best-effort scan is running.
      if (readCurrentGeneration(dir) === generation.name) continue;
      if (generationCreationIsActive(generationDir, generation.name)) continue;
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
  const dir = path.join(globalStateDir(), 'tls');
  const sanEntries = lanIpSanEntries(Array.isArray(extraHosts) ? extraHosts : [extraHosts]);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}

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
    try { fs.chmodSync(path.join(dir, 'self-signed.key'), 0o600); } catch {}
    try { fs.chmodSync(path.join(dir, 'self-signed.crt'), 0o600); } catch {}
    return createGeneration(dir, sanEntries, legacy);
  }

  return createGeneration(dir, sanEntries);
}
