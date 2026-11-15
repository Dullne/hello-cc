import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CliError } from '../shared/errors.mjs';
import { compareProcessIdentity, inspectProcessIdentity } from '../process/identity.mjs';
import { captureDirectory } from './windows-filesystem.mjs';
import { sameWindowsFileIdentity, readWindowsPrivateFile, removeWindowsPrivateDirectory,
  withWindowsPrivateDirectory, captureWindowsPrivateDatabase } from './windows-private-state.mjs';
import { privateProjectStateManifest, privateStateBaseDir, withPrivateProjectStateTransition } from '../runtime/private-state.mjs';

const MARKER = '.project-root.json';
const RECEIPT = '.migration-in-progress.json';
const SCRATCH = '.migration-sqlite';
const unsafe = message => new CliError('STATE_MIGRATION_UNSAFE', message);
const exists = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const json = value => Buffer.from(`${JSON.stringify(value)}\n`);
const quote = value => `'${value.replaceAll("'", "''")}'`;
const isDb = name => /\.(?:db|sqlite)$/i.test(name);
const sidecar = name => /^(.*\.(?:db|sqlite))-(?:wal|shm)$/i.exec(name)?.[1];

function assertOffline(callback, phase) {
  if (typeof callback !== 'function' || callback({ phase }) !== true) {
    throw new CliError('STATE_MIGRATION_OFFLINE_REQUIRED', `All legacy state writers must be stopped (${phase})`);
  }
}
function checkPrivate(handle, label) {
  handle.assertUnchanged();
  if (handle.security().private !== true) throw unsafe(`Legacy migration requires a current-user-owned private ACL: ${label}. Back up and review permissions before retrying.`);
  const snap = handle.snapshot();
  if (snap.type === 'file' && snap.nlink !== '1') throw unsafe(`Legacy state contains a hard link: ${label}`);
  return snap;
}
function list(directory) {
  const result = directory.list({ maxScanned: 5000 });
  if (result.truncated || result.omittedNames.length || result.scanned !== result.entries.length) {
    throw unsafe('Legacy directory contains an unreadable, reparse, hard-linked or unsupported entry, or exceeds 5000 entries');
  }
  return result.entries.sort((a, b) => a.name.localeCompare(b.name));
}
function smallJson(handle, label) {
  if (BigInt(handle.snapshot().size) > 65536n) throw unsafe(`Legacy metadata is too large: ${label}`);
  try {
    const value = JSON.parse(handle.read(65536).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw unsafe(`Legacy metadata is invalid: ${label}`); }
}
function dead(pid, identity, label) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw unsafe(`Cannot establish offline process identity: ${label}`);
  const current = inspectProcessIdentity(pid);
  if (current.state === 'dead' || (current.state === 'live' && identity && compareProcessIdentity(identity, current.identity) === 'dead')) return;
  throw unsafe(`Cannot establish offline state: ${label} process is live or unknown`);
}
function processMetadata(handle, relative) {
  relative = relative.toLowerCase();
  const pointer = relative === 'runtime.json' || relative === path.join('native', 'runtime.json');
  if (pointer) {
    const value = smallJson(handle, relative);
    dead(value.pid, value.process_identity || value.processIdentity, relative);
  } else if (path.dirname(relative) === 'bufs' && relative.endsWith('.meta')) {
    const value = smallJson(handle, relative), wrapper = value.wrapper_pid ?? value.wrapperPid;
    if (wrapper == null && value.pid == null) throw unsafe(`Cannot establish offline PTY owner: ${relative}`);
    if (wrapper != null) dead(wrapper, value.wrapper_identity || value.wrapperIdentity, relative);
    if (value.pid != null) dead(value.pid, value.child_identity || value.childIdentity, relative);
  }
  return pointer;
}

// A volume observation creates no sentinel. Every subsequent handle-relative
// directory open denies DELETE sharing, including all project ancestors. Keep
// these handles and no-WRITE file readers until final publication. No source
// pathname is ever opened by SQLite and no file is created in the source.
function captureSource(root) {
  const requested = path.resolve(root), volume = captureDirectory(path.parse(requested).root, { pin: false });
  const held = [volume], directories = [], files = [];
  try {
    const project = volume.openDirectory(requested.slice(path.parse(requested).root.length).split(path.sep).join('/')); held.push(project);
    const projectSnapshot = project.snapshot();
    const owner = project.security();
    if (owner.ownerSid !== owner.userSid) throw unsafe('Legacy project ownership cannot be established');
    const source = project.openDirectory('.hello-cc'); held.push(source);
    const sourceSnapshot = checkPrivate(source, '.hello-cc');
    function scan(directory, relative = '') {
      checkPrivate(directory, relative || '.hello-cc');
      const entries = list(directory); directories.push({ handle: directory, relative, entries });
      const names = new Set(entries.map(e => e.name.toLowerCase()));
      for (const entry of entries) {
        const child = path.join(relative, entry.name);
        if ((!relative && [MARKER, RECEIPT, SCRATCH].includes(entry.name.toLowerCase())) || /^\.hcc-cwd-pin-/i.test(entry.name)) {
          throw unsafe(`Legacy state contains a reserved migration entry: ${child}`);
        }
        if (sidecar(entry.name) && !names.has(sidecar(entry.name).toLowerCase())) throw unsafe(`Orphaned SQLite sidecar: ${child}`);
        if (/\.(?:db|sqlite)-journal$/i.test(entry.name)) throw unsafe(`SQLite rollback journal requires manual recovery: ${child}`);
        const handle = entry.type === 'directory' ? directory.openDirectory(entry.name) : directory.openFile(entry.name);
        held.push(handle); checkPrivate(handle, child);
        if (entry.type === 'directory') scan(handle, child);
        else files.push({ handle, relative: child, pointer: processMetadata(handle, child) });
      }
    }
    scan(source);
    return { projectSnapshot, sourceSnapshot, files, directories,
      verify() {
        project.assertUnchanged();
        for (const d of directories) {
          checkPrivate(d.handle, d.relative);
          if (JSON.stringify(list(d.handle)) !== JSON.stringify(d.entries)) throw unsafe('Legacy state changed during migration');
        }
        for (const file of files) { checkPrivate(file.handle, file.relative); processMetadata(file.handle, file.relative); }
      },
      close() { for (const handle of held.reverse()) handle.close(); }
    };
  } catch (error) { for (const handle of held.reverse()) handle.close(); throw error; }
}

function checkDatabase(db, relative) {
  relative = relative.toLowerCase();
  const integrity = db.prepare('PRAGMA quick_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw unsafe(`SQLite integrity check failed: ${relative}`);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  if (relative === 'mesh.db' && tables.some(t => t.name.toLowerCase() === 'peers')) {
    const columns = db.prepare('PRAGMA table_info(peers)').all().map(r => r.name.toLowerCase());
    if (columns.includes('pid')) {
      const fingerprint = columns.includes('pid_start_token') && columns.includes('pid_command_hash');
      const fields = fingerprint ? ', pid_start_token AS pid_start_token, pid_command_hash AS pid_command_hash' : '';
      for (const row of db.prepare(`SELECT pid AS pid${fields} FROM peers WHERE pid IS NOT NULL`).all()) {
        const identity = row.pid_start_token && row.pid_command_hash ? { pid: Number(row.pid), startToken: row.pid_start_token, commandHash: row.pid_command_hash } : null;
        dead(Number(row.pid), identity, 'mesh peer');
      }
    }
  }
  if (relative === path.join('native', 'state.db') && tables.some(t => t.name.toLowerCase() === 'native_owner')) {
    for (const row of db.prepare("SELECT pid AS pid, start_token AS start_token, command_hash AS command_hash FROM native_owner WHERE state IS NOT 'released'").all()) {
      dead(Number(row.pid), row.start_token && row.command_hash ? { pid: Number(row.pid), startToken: row.start_token, commandHash: row.command_hash } : null, 'native owner');
    }
  }
  return tables.map(({ name }) => [name, String(db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get().n)]);
}

function createEmpty(parent, name) {
  const published = parent.publish(name, Buffer.alloc(0), { operation: 'create', private: true });
  const handle = parent.openMutableFile(name);
  if (!sameWindowsFileIdentity(published.identity, handle.snapshot().identity)) { handle.close(); throw unsafe('Migration destination changed'); }
  checkPrivate(handle, name); return handle;
}
function copyFile(file, parent, name, { retain = false } = {}) {
  const output = createEmpty(parent, name); let inputFd, outputFd, immutable;
  try {
    const source = checkPrivate(file.handle, file.relative);
    // The native readers retain the source object and every ancestor without
    // WRITE/DELETE sharing; this streaming path supports files larger than the
    // native bounded preview Buffer without following a replacement object.
    inputFd = fs.openSync(source.canonical, 'r'); outputFd = fs.openSync(output.snapshot().canonical, 'r+');
    const bytes = Buffer.allocUnsafe(128 * 1024);
    for (;;) {
      const n = fs.readSync(inputFd, bytes, 0, bytes.length, null); if (!n) break;
      let offset = 0; while (offset < n) offset += fs.writeSync(outputFd, bytes, offset, n - offset);
    }
    fs.fsyncSync(outputFd); fs.closeSync(outputFd); outputFd = undefined;
    checkPrivate(file.handle, file.relative); checkPrivate(output, name);
    if (retain) {
      immutable = parent.openFile(name);
      if (!sameWindowsFileIdentity(checkPrivate(immutable, name).identity, output.snapshot().identity)) throw unsafe('Migration output changed before protection');
    }
    return immutable;
  } catch (error) { immutable?.close(); throw error; }
  finally { if (inputFd !== undefined) fs.closeSync(inputFd); if (outputFd !== undefined) fs.closeSync(outputFd); output.close(); }
}

function dshArchive(source) {
  const names = ['hooks.json', 'cordis.patch.yml', 'managed.json'];
  const files = source.files.filter(f => path.dirname(f.relative).toLowerCase() === 'dsh' && names.includes(path.basename(f.relative).toLowerCase()));
  if (!files.length) return null;
  const manifestFile = files.find(f => path.basename(f.relative).toLowerCase() === 'managed.json');
  if (!manifestFile) throw unsafe('DSH artifacts lack a verifiable managed manifest');
  const manifest = smallJson(manifestFile.handle, 'DSH manifest'), mode = manifest.mode ?? 'hooks';
  if (manifest.managedBy !== 'hello-cc/dsh' || manifest.schema !== 1 || manifest.root !== source.projectSnapshot.canonical ||
      !['hooks', 'cordis', 'off'].includes(mode) || !manifest.files || typeof manifest.hccBin !== 'string' ||
      !path.isAbsolute(manifest.hccBin) || typeof manifest.nodeBin !== 'string' || !path.isAbsolute(manifest.nodeBin)) throw unsafe('DSH managed manifest cannot be verified');
  for (const file of files.filter(f => f !== manifestFile)) {
    if (BigInt(file.handle.snapshot().size) > 10n * 1024n * 1024n) throw unsafe('DSH artifact is too large');
    if (createHash('sha256').update(file.handle.read(10 * 1024 * 1024)).digest('hex') !== manifest.files[path.basename(file.relative).toLowerCase()]) throw unsafe('DSH artifact differs from its manifest');
    if (path.basename(file.relative).toLowerCase() === 'hooks.json') {
      const hooks = smallJson(file.handle, 'DSH hooks');
      if (hooks._helloCc?.managedBy !== 'hello-cc/dsh' || hooks._helloCc?.schema !== 1) throw unsafe('DSH hooks have no valid ownership marker');
    }
  }
  return { mode, names, directory: path.dirname(manifestFile.relative), archiveName: `.legacy-managed-${randomBytes(8).toString('hex')}`, rebuildCommand: `hcc dsh setup --mode ${mode}` };
}

function copyState(source, destination, directory, summary) {
  const held = [], scratchHeld = [], outputDirs = new Map([['', directory]]), scratchDirs = new Map();
  let scratchIdentity;
  try {
    const scratch = directory.createDirectory(SCRATCH, { private: true }); scratchHeld.push(scratch);
    scratchIdentity = scratch.snapshot().identity; scratchDirs.set('', scratch);
    for (const entry of source.directories.filter(d => d.relative)) {
      for (const map of [outputDirs, scratchDirs]) {
        const parent = map.get(path.dirname(entry.relative) === '.' ? '' : path.dirname(entry.relative));
        const created = parent.createDirectory(path.basename(entry.relative), { private: true });
        (map === outputDirs ? held : scratchHeld).push(created); map.set(entry.relative, created);
      }
    }
    const dsh = dshArchive(source); summary.dsh = dsh && { mode: dsh.mode, archiveName: dsh.archiveName, rebuildCommand: dsh.rebuildCommand };
    if (dsh) { const archive = outputDirs.get(dsh.directory).createDirectory(dsh.archiveName, { private: true }); held.push(archive); outputDirs.set(path.join(dsh.directory, dsh.archiveName), archive); }
    for (const file of source.files) {
      const relativeDir = path.dirname(file.relative) === '.' ? '' : path.dirname(file.relative), name = path.basename(file.relative);
      if (file.pointer) { summary.omittedPointers++; continue; }
      if (sidecar(name) && /-shm$/i.test(name)) continue;
      if (isDb(name) || sidecar(name)) copyFile(file, scratchDirs.get(relativeDir), name);
      else {
        const parent = dsh && relativeDir.toLowerCase() === 'dsh' && dsh.names.includes(name.toLowerCase()) ? outputDirs.get(path.join(dsh.directory, dsh.archiveName)) : outputDirs.get(relativeDir);
        held.push(copyFile(file, parent, name, { retain: true })); summary.files++;
      }
    }
    for (const file of source.files.filter(f => isDb(f.relative))) {
      const relativeDir = path.dirname(file.relative) === '.' ? '' : path.dirname(file.relative), name = path.basename(file.relative);
      const output = createEmpty(outputDirs.get(relativeDir), name); let db, verified, scratchHold, immutable;
      try {
        const scratchPath = path.join(destination, SCRATCH, file.relative);
        scratchHold = captureWindowsPrivateDatabase(scratchPath);
        db = new DatabaseSync(scratchPath, { timeout: 1000 });
        const before = checkDatabase(db, file.relative), target = output.snapshot().canonical;
        db.exec(`VACUUM INTO ${quote(target)}`); db.close(); db = null;
        output.assertUnchanged(); const fd = fs.openSync(target, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        immutable = outputDirs.get(relativeDir).openFile(name);
        if (!sameWindowsFileIdentity(checkPrivate(immutable, name).identity, output.snapshot().identity)) throw unsafe('SQLite output changed before verification');
        verified = new DatabaseSync(target, { readOnly: true, timeout: 1000 });
        if (JSON.stringify(checkDatabase(verified, file.relative)) !== JSON.stringify(before)) throw unsafe('SQLite snapshot row counts changed');
        verified.close(); verified = null; checkPrivate(immutable, name); held.push(immutable); immutable = null; summary.databases++;
      } finally { verified?.close(); db?.close(); scratchHold?.close(); immutable?.close(); output.close(); }
    }
    for (const dir of outputDirs.values()) dir.flush();
    for (const handle of scratchHeld.splice(0).reverse()) handle.close();
    removeWindowsPrivateDirectory(path.join(destination, SCRATCH), scratchIdentity);
    // The scratch removal owns an additional transition pin in the output
    // root. Account for exactly our pins; never ignore arbitrary lookalikes.
    const sentinels = new Map([...outputDirs.values()].map(d => [d, new Set([d.snapshot().sentinelName].filter(Boolean))]));
    withWindowsPrivateDirectory(destination, scoped => { sentinels.get(directory).add(scoped.snapshot().sentinelName); });
    const listing = directory => {
      const owned = sentinels.get(directory);
      const result = directory.list({ maxScanned: 5000 });
      if (result.truncated || result.omittedNames.some(name => !owned.has(name)) ||
          result.scanned !== result.entries.length + result.omittedNames.length) throw unsafe('Migration destination contains an unexpected entry');
      return result.entries.filter(e => !owned.has(e.name)).map(e => ({ name: e.name, type: e.type })).sort((a, b) => a.name.localeCompare(b.name));
    };
    const inventory = [...outputDirs.values()].map(handle => ({ handle, entries: listing(handle) }));
    return {
      verify() {
        for (const handle of [directory, ...held]) checkPrivate(handle, 'migration output');
        for (const entry of inventory) if (JSON.stringify(listing(entry.handle)) !== JSON.stringify(entry.entries)) throw unsafe('Migration destination changed before publication');
      },
      close() { for (const handle of held.splice(0).reverse()) handle.close(); }
    };
  } catch (error) { for (const handle of held.splice(0).reverse()) handle.close(); throw error; }
  finally { for (const handle of scratchHeld.splice(0).reverse()) handle.close(); }
}

export function migrateWindowsLegacyProjectState(root, { confirmedOffline = false, assertOffline: callback } = {}) {
  if (confirmedOffline !== true) throw new CliError('STATE_MIGRATION_OFFLINE_REQUIRED', 'Explicit offline migration confirmation is required');
  assertOffline(callback, 'before');
  const source = captureSource(root);
  try {
    return withPrivateProjectStateTransition(source.projectSnapshot.canonical, ({ directory: destination, project, setAuthorityKind }) => {
      if (!sameWindowsFileIdentity(project.identity, source.projectSnapshot.identity)) throw unsafe('Project identity changed before migration');
      if (destination.startsWith(source.sourceSnapshot.canonical + path.sep)) throw unsafe('Legacy source overlaps private destination');
      const globalPointer = path.join(privateStateBaseDir(), 'runtime.json');
      const checkGlobal = () => {
        const bytes = readWindowsPrivateFile(globalPointer, { missing: true });
        if (bytes) { let value; try { value = JSON.parse(bytes); } catch { throw unsafe('Global runtime pointer is invalid'); }
          dead(value.pid, value.process_identity || value.processIdentity, 'global runtime'); }
      };
      checkGlobal();
      return withWindowsPrivateDirectory(path.dirname(destination), parent => {
      let output, copied;
      try {
        if (exists(destination)) {
          const collision = () => new CliError('STATE_MIGRATION_EXISTS', `Private project state already exists: ${destination}. Preserve it; only an identity-bound unpublished migration can be retried automatically.`);
          if (exists(path.join(destination, MARKER))) throw collision();
          let receipt, snapshot;
          try {
            const existing = parent.openDirectory(path.basename(destination));
            try { snapshot = checkPrivate(existing, destination); } finally { existing.close(); }
            receipt = JSON.parse(readWindowsPrivateFile(path.join(destination, RECEIPT)));
          } catch { throw collision(); }
          if (receipt.version !== 1 || receipt.operation !== 'windows-legacy-import' || receipt.phase !== 'copying' || receipt.canonicalRoot !== source.projectSnapshot.canonical ||
              !sameWindowsFileIdentity(receipt.rootIdentity, source.projectSnapshot.identity) ||
              !sameWindowsFileIdentity(receipt.sourceIdentity, source.sourceSnapshot.identity) ||
              !sameWindowsFileIdentity(receipt.destinationIdentity, snapshot.identity)) throw collision();
          removeWindowsPrivateDirectory(destination, snapshot.identity);
        }
        // Persist the fence first. Normal access refuses a missing destination
        // or an absent binding manifest. A crash before the receipt is durable
        // leaves an unclaimed directory: preserve it for manual review.
        setAuthorityKind('migrated');
        output = parent.createDirectory(path.basename(destination), { private: true }); parent.flush();
        const receipt = { version: 1, operation: 'windows-legacy-import', phase: 'copying', canonicalRoot: source.projectSnapshot.canonical,
          rootIdentity: source.projectSnapshot.identity, sourceIdentity: source.sourceSnapshot.identity,
          destinationIdentity: output.snapshot().identity };
        const receiptObject = output.publish(RECEIPT, json(receipt), { operation: 'create', private: true }); output.flush();
        const summary = { files: 0, databases: 0, omittedPointers: 0 };
        copied = copyState(source, destination, output, summary);
        assertOffline(callback, 'after'); source.verify(); copied.verify(); checkGlobal();
        const binding = privateProjectStateManifest(project.canonical);
        if (!sameWindowsFileIdentity(binding.identity, source.projectSnapshot.identity)) throw unsafe('Project binding changed');
        // Disable destructive retry before the commit point. Otherwise a lost
        // binding marker could make a completed store (with later user writes)
        // look like our interrupted copy. A crash in this final narrow window
        // requires manual recovery and retains both source and destination.
        const publicationReceipt = output.publish(RECEIPT, json({ ...receipt, phase: 'publishing' }), {
          operation: 'replace', private: true, expectedIdentity: receiptObject.identity, expectedBytes: json(receipt)
        }); output.flush();
        // The final marker is the sole commit point. Never remove a published
        // destination on errors: a failed flush is an uncertain commit.
        output.publish(MARKER, json(binding), { operation: 'create', private: true }); output.flush(); parent.flush();
        output.removeFile(RECEIPT, { expectedIdentity: publicationReceipt.identity }); output.flush();
        if (summary.dsh) summary.dsh.archivePath = path.join(destination, 'dsh', summary.dsh.archiveName);
        return { stateDir: destination, sourceDir: source.sourceSnapshot.canonical, ...summary };
      } finally { copied?.close(); output?.close(); }
      });
    });
  } finally { source.close(); }
}
