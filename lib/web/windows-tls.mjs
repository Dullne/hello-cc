import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CliError } from '../shared/errors.mjs';
import { withFileLock } from '../shared/file-lock.mjs';
import { resolveWindowsCommand } from '../platform/windows-command.mjs';
import { captureDirectory } from '../platform/windows-filesystem.mjs';
import { createWindowsPrivateDirectory, inspectWindowsPrivateDirectory,
  publishWindowsPrivateManifest, readWindowsPrivateFile, withWindowsPrivateScope,
  sameWindowsFileIdentity
} from '../platform/windows-private-state.mjs';

export function windowsOpenSsl() {
  try { return resolveWindowsCommand('openssl'); } catch { return null; }
}

function pointer(dir) {
  const bytes = readWindowsPrivateFile(path.join(dir, 'current.json'), { maxBytes: 16384, missing: true });
  if (bytes === null) return null;
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch {}
  if (!/^generation-[a-f0-9]{32}$/.test(value?.generation || '')) {
    throw new CliError('PROJECT_PATH_FORBIDDEN', 'Invalid Windows TLS generation pointer.');
  }
  return value;
}

function readCredentials(dir, current, sanEntries, reusable) {
  if (!current) return null;
  const generation = path.join(dir, current.generation);
  inspectWindowsPrivateDirectory(generation);
  const key = readWindowsPrivateFile(path.join(generation, 'self-signed.key'), { maxBytes: 16384 }).toString('utf8');
  const certPath = path.join(generation, 'self-signed.crt');
  const cert = readWindowsPrivateFile(certPath, { maxBytes: 65536 }).toString('utf8');
  return reusable({ key, cert, sanEntries }) ? { key, cert, certPath } : null;
}

function generate(sanEntries, reusable) {
  const command = windowsOpenSsl();
  if (!command) throw new CliError('TLS_UNAVAILABLE', 'OpenSSL is required to generate a TLS certificate. Install OpenSSL and add its executable to PATH, or use web --local.');
  // Both PEM objects stay in the pipe. OpenSSL never opens a private-state path,
  // and an empty configuration prevents an ambient config from redirecting keys.
  const result = spawnSync(command.file, [...command.args,
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '-', '-out', '-',
    '-config', 'NUL', '-days', '365', '-subj', '/CN=localhost',
    '-addext', `subjectAltName=${sanEntries.join(',')}`
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  const key = result.stdout?.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/)?.[0];
  const cert = result.stdout?.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0];
  if (result.status !== 0 || !key || !cert || !reusable({ key, cert, sanEntries })) {
    // Never include OpenSSL stdout/stderr: a failed command may echo key material.
    throw new CliError('TLS_UNAVAILABLE', 'OpenSSL did not produce a valid TLS certificate.', {
      reason: result.error?.code || `exit_${result.status}`
    });
  }
  return { key: key + '\n', cert: cert + '\n' };
}

export function ensureWindowsSelfSignedCert(dir, sanEntries, reusable) {
  return withWindowsPrivateScope(() => {
    inspectWindowsPrivateDirectory(dir);
    return withFileLock(path.join(dir, 'current.json'), () => {
      const expected = pointer(dir);
      const existing = readCredentials(dir, expected, sanEntries, reusable);
      if (existing) return existing;
      const credentials = generate(sanEntries, reusable);
      const generation = `generation-${randomBytes(16).toString('hex')}`;
      const directory = path.join(dir, generation);
      createWindowsPrivateDirectory(directory);
      const held = captureDirectory(directory, { pin: true });
      let parent;
      const files = [];
      const assertCredentialsHeld = () => {
        parent.assertUnchanged();
        if (parent.security().private !== true) throw new CliError('PROJECT_PATH_FORBIDDEN', 'Windows TLS generation permissions changed.');
        for (const { handle, identity } of files) {
          handle.assertUnchanged();
          const snapshot = handle.snapshot();
          if (!sameWindowsFileIdentity(snapshot.identity, identity) || snapshot.nlink !== '1' || handle.security().private !== true) {
            throw new CliError('PROJECT_PATH_FORBIDDEN', 'Windows TLS credential identity or permissions changed.');
          }
        }
      };
      try {
        parent = held.openDirectory('');
        for (const [name, contents] of [['self-signed.key', credentials.key], ['self-signed.crt', credentials.cert]]) {
          const receipt = parent.publish(name, Buffer.from(contents), { operation: 'create', private: true });
          const handle = parent.openFile(name);
          files.push({ handle, identity: receipt.identity });
          assertCredentialsHeld();
          // Identity alone cannot detect an in-place write between native
          // publication and acquiring this immutable reader. Compare the held
          // bytes with the generated, validated pair before publishing it.
          const expectedBytes = Buffer.from(contents);
          if (BigInt(handle.snapshot().size) !== BigInt(expectedBytes.length) ||
              !handle.read(expectedBytes.length).equals(expectedBytes)) {
            throw new CliError('PROJECT_FILE_CHANGED', 'Windows TLS credential bytes changed before protection.');
          }
        }
        parent.flush();
        assertCredentialsHeld();
        // The lock serializes cooperating publishers. Immutable native readers
        // also retain both exact credential objects through pointer publication.
        publishWindowsPrivateManifest(path.join(dir, 'current.json'), { generation }, expected);
        try { assertCredentialsHeld(); }
        catch (error) {
          throw new CliError('TLS_PUBLICATION_UNCONFIRMED',
            'The TLS pointer was published, but credential integrity could not be confirmed. Preserve the TLS directory and inspect its permissions.',
            { reason: error.code });
        }
        return { ...credentials, certPath: path.join(directory, 'self-signed.crt') };
      } finally {
        for (const { handle } of files.reverse()) handle.close();
        parent?.close(); held.close();
      }
    }, { createParent: false, timeoutMs: 45000 });
  });
}
