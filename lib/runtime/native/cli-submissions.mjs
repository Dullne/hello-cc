import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../../shared/errors.mjs';
import { ensurePrivateProjectStateSubdirectory } from '../project-path.mjs';
import { readPrivateTextFile } from '../private-file.mjs';
import { unsafeDirectoryAcl } from '../project-trust.mjs';
import { nativePaths } from './store.mjs';

const DIRECTORY = 'native-cli-submissions';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_VALUE = new RegExp(`^${UUID}$`);
const PREPARED = new RegExp(`^submission-(${UUID})\\.json$`);

function journalDirectory(ctx, create) {
  const native = nativePaths(ctx, { create });
  if (!native) return null;
  const directory = ensurePrivateProjectStateSubdirectory(ctx.root, DIRECTORY, { create });
  if (directory && path.dirname(directory) !== path.dirname(native.dir)) {
    throw new CliError('PROJECT_PATH_CHANGED', 'CLI submissions do not match the selected native state');
  }
  if (directory && create) syncDirectory(path.dirname(directory));
  return directory ? { directory, meshDbRelative: path.relative(path.dirname(native.dir), native.meshDb) } : null;
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY |
    (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeRecord(directory, name, value) {
  const file = path.join(directory, name);
  const temporaryName = `.${name}.tmp.${randomBytes(12).toString('hex')}`;
  const temporary = path.join(directory, temporaryName);
  let fd;
  let opened;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    opened = fs.fstatSync(fd);
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    const secured = fs.fstatSync(fd);
    if (!secured.isFile() || secured.nlink !== 1 || secured.dev !== opened.dev || secured.ino !== opened.ino ||
        (typeof process.geteuid === 'function' && secured.uid !== process.geteuid()) ||
        (process.platform !== 'win32' && (secured.mode & 0o777) !== 0o600) ||
        unsafeDirectoryAcl(temporary, secured)) {
      throw new Error('Unsafe CLI submission journal file');
    }
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const ready = fs.lstatSync(temporary);
    if (!ready.isFile() || ready.isSymbolicLink() || ready.nlink !== 1 ||
        ready.dev !== opened.dev || ready.ino !== opened.ino) {
      throw new Error('CLI submission journal temporary file changed before publication');
    }
    fs.linkSync(temporary, file);
    try { fs.unlinkSync(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    syncDirectory(directory);
    const published = fs.lstatSync(file);
    if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1 ||
        published.dev !== opened.dev || published.ino !== opened.ino) {
      throw new Error('CLI submission journal file changed after publication');
    }
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* Preserve the write failure. */ }
    if (opened) {
      try {
        const current = fs.lstatSync(temporary);
        if (current.dev === opened.dev && current.ino === opened.ino) fs.unlinkSync(temporary);
      } catch { /* The failed write must never authorize a send. */ }
    }
    throw new CliError('NATIVE_CLI_JOURNAL_FAILED', 'Cannot durably save the native CLI submission record',
      { cause: error.code || 'WRITE_FAILED' });
  }
}

function repairPublishedLink(directory, name) {
  const file = path.join(directory, name);
  const published = fs.lstatSync(file);
  if (published.nlink === 1) return;
  if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 2) {
    throw new CliError('NATIVE_CLI_JOURNAL_INVALID', 'Native CLI submission journal has an unexpected hard link');
  }
  const prefix = `.${name}.tmp.`;
  for (const candidate of fs.readdirSync(directory)) {
    if (!candidate.startsWith(prefix)) continue;
    const temporary = path.join(directory, candidate);
    let stat;
    try { stat = fs.lstatSync(temporary); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== published.dev || stat.ino !== published.ino) continue;
    try { fs.unlinkSync(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    syncDirectory(directory);
    const repaired = fs.lstatSync(file);
    if (repaired.dev === published.dev && repaired.ino === published.ino && repaired.nlink === 1) return;
    break;
  }
  // Another reader may have removed the matching temp link after our first stat.
  const repaired = fs.lstatSync(file);
  if (repaired.dev === published.dev && repaired.ino === published.ino && repaired.nlink === 1) return;
  throw new CliError('NATIVE_CLI_JOURNAL_INVALID', 'Native CLI submission journal has an unresolved hard link');
}

function readRecord(directory, name) {
  repairPublishedLink(directory, name);
  const raw = readPrivateTextFile(path.join(directory, name), { maxBytes: 4096 });
  if (raw === null) throw new CliError('NATIVE_CLI_JOURNAL_INVALID', 'Native CLI submission journal changed during inspection');
  try { return JSON.parse(raw); }
  catch { throw new CliError('NATIVE_CLI_JOURNAL_INVALID', 'Native CLI submission journal is invalid'); }
}

function optionalRecord(directory, name) {
  try { fs.lstatSync(path.join(directory, name)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return readRecord(directory, name);
}

function validatePrepared(record, id, root, meshDbRelative) {
  if (record?.version !== 1 || record.submission_id !== id ||
      record.root !== root || record.mesh_db_relative !== meshDbRelative ||
      typeof record.peer !== 'string' || !record.peer || typeof record.from !== 'string' || !record.from ||
      !(record.task_id === null || (Number.isSafeInteger(record.task_id) && record.task_id > 0)) ||
      !/^[a-f0-9]{64}$/.test(record.body_sha256) ||
      !Number.isFinite(Date.parse(record.created_at))) {
    throw new CliError('NATIVE_CLI_JOURNAL_INVALID', 'Native CLI submission journal does not match this project');
  }
  return record;
}

export function prepareCliSubmission(ctx, input) {
  const { directory, meshDbRelative } = journalDirectory(ctx, true);
  const record = {
    version: 1, submission_id: randomUUID(), root: fs.realpathSync(ctx.root), mesh_db_relative: meshDbRelative,
    peer: input.peer, from: input.from, task_id: input.taskId || null,
    body_sha256: createHash('sha256').update(input.body).digest('hex'), created_at: new Date().toISOString()
  };
  writeRecord(directory, `submission-${record.submission_id}.json`, record);
  return record;
}

export function recordCliSubmissionReceipt(ctx, record, receipt) {
  if (!Number.isSafeInteger(receipt?.message_id) || receipt.message_id < 1 ||
      receipt.submission_id !== record.submission_id || typeof receipt.state !== 'string') {
    throw new CliError('NATIVE_RESPONSE_INVALID', 'Native queue receipt does not match the prepared CLI submission',
      { uncertain: true });
  }
  const { directory } = journalDirectory(ctx, true);
  const name = `receipt-${record.submission_id}.json`;
  const existing = optionalRecord(directory, name);
  if (existing) {
    if (existing.version !== 1 || existing.submission_id !== record.submission_id ||
        existing.message_id !== receipt.message_id || typeof existing.state !== 'string') {
      throw new CliError('NATIVE_CLI_JOURNAL_INVALID', 'Native CLI submission receipt conflicts with the saved receipt');
    }
    return;
  }
  try {
    writeRecord(directory, name, {
      version: 1, submission_id: record.submission_id, message_id: receipt.message_id, state: receipt.state
    });
  } catch (error) {
    if (error.code !== 'NATIVE_CLI_JOURNAL_FAILED' || error.extra?.cause !== 'EEXIST') throw error;
    const winner = optionalRecord(directory, name);
    if (!winner) throw error;
    if (winner.version !== 1 || winner.submission_id !== record.submission_id ||
        winner.message_id !== receipt.message_id || typeof winner.state !== 'string') {
      throw new CliError('NATIVE_CLI_JOURNAL_INVALID', 'Native CLI submission receipt conflicts with the saved receipt');
    }
  }
}

export function matchingCliSubmission(ctx, input) {
  if (!UUID_VALUE.test(input.submissionId)) return null;
  const journal = journalDirectory(ctx, false);
  if (!journal) return null;
  const { directory, meshDbRelative } = journal;
  const saved = optionalRecord(directory, `submission-${input.submissionId}.json`);
  if (!saved) return null;
  const record = validatePrepared(saved, input.submissionId, fs.realpathSync(ctx.root), meshDbRelative);
  if (record.peer !== input.peer || record.from !== input.from ||
      record.task_id !== (input.taskId || null) ||
      record.body_sha256 !== createHash('sha256').update(input.body).digest('hex')) {
    throw new CliError('NATIVE_SUBMISSION_MISMATCH', 'Retry must keep the prepared CLI peer, sender, task and body');
  }
  return record;
}

export function listCliSubmissions(ctx, { peer = null } = {}) {
  const journal = journalDirectory(ctx, false);
  if (!journal) return [];
  const { directory, meshDbRelative } = journal;
  const root = fs.realpathSync(ctx.root);
  const entries = [];
  for (const name of fs.readdirSync(directory)) {
    const match = name.match(PREPARED);
    if (!match) continue;
    const record = validatePrepared(readRecord(directory, name), match[1], root, meshDbRelative);
    if (peer && record.peer !== peer) continue;
    const receiptName = `receipt-${record.submission_id}.json`;
    let receipt = optionalRecord(directory, receiptName);
    if (receipt) {
      if (receipt?.version !== 1 || receipt.submission_id !== record.submission_id ||
          !Number.isSafeInteger(receipt.message_id) || receipt.message_id < 1 || typeof receipt.state !== 'string') {
        throw new CliError('NATIVE_CLI_JOURNAL_INVALID', 'Native CLI submission receipt is invalid');
      }
      receipt = { message_id: receipt.message_id, submission_id: receipt.submission_id, state: receipt.state };
    }
    entries.push({ submission_id: record.submission_id, peer: record.peer, from: record.from,
      task_id: record.task_id, body_sha256: record.body_sha256, created_at: record.created_at,
      confirmation: receipt ? 'received' : 'unconfirmed', receipt });
  }
  return entries.sort((a, b) => b.created_at.localeCompare(a.created_at) ||
    b.submission_id.localeCompare(a.submission_id));
}
