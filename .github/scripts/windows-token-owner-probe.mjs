import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('The ownership probe requires Windows.');

if (process.argv[2] === '--worker') {
  const { DatabaseSync } = await import('node:sqlite');
  const { loadWindowsNative } = await import('../../lib/platform/windows-native.mjs');
  const native = loadWindowsNative();
  const directory = path.join(process.argv[3], 'private');
  let database;
  try {
    native.createPrivateDirectory(directory);
    fs.writeFileSync(path.join(directory, 'child.txt'), 'isolated ownership probe');
    database = new DatabaseSync(path.join(directory, 'state.db'));
    database.exec('PRAGMA journal_mode=WAL; CREATE TABLE probe(value); INSERT INTO probe VALUES(1)');
    const objects = [directory, ...fs.readdirSync(directory).map(name => path.join(directory, name))];
    process.stdout.write(JSON.stringify(objects.map(file => ({ name: path.basename(file), ...native.inspectPathSecurity(file) }))));
  } finally {
    database?.close();
  }
} else {
  const temporary = process.env.RUNNER_TEMP || os.tmpdir();
  const root = fs.mkdtempSync(path.join(temporary, 'hcc-ci-owner-probe-'));
  const logDirectory = path.join(temporary, 'hcc-windows-token-owner');
  fs.mkdirSync(logDirectory, { recursive: true });
  const receipt = { ok: false, files: [] };
  try {
    // The worker only creates this small fixture and never launches children.
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), '--worker', root], {
      encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 65536,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`The ownership probe worker exited with status ${result.status}. ${result.stderr.slice(0, 1000)}`);
    receipt.files = JSON.parse(result.stdout);
    receipt.ok = receipt.files.length === 5 && receipt.files.every(file => file.private && file.ownerSid === file.userSid);
    if (!receipt.ok) throw new Error('Fresh private files or SQLite sidecars do not belong exclusively to the current Windows user.');
    process.stdout.write(`[hcc-token-owner] private files ${JSON.stringify(receipt)}\n`);
  } catch (error) {
    receipt.error = { code: error.code || null, message: error.message.slice(0, 1200) };
    throw error;
  } finally {
    fs.writeFileSync(path.join(logDirectory, 'private-files.json'), JSON.stringify(receipt, null, 2) + '\n');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
