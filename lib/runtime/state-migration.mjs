/**
 * Explicit, offline migration of the legacy project-local state directory.
 *
 * The caller must first stop every producer (including external/unknown DB
 * writers), obtain the user's confirmation, and supply a synchronous
 * assertOffline callback that returns true both before and after the copy.
 * Process pointers are checked here as additional evidence, not as proof that
 * an unregistered writer cannot exist. No process is stopped by this module.
 *
 * A dedicated child process anchors its cwd in the validated legacy directory.
 * Its source reads use relative names and no-follow opens. In particular, a
 * rename/replacement of the project root cannot redirect subsequent reads.
 * SQLite files and WALs are first copied into a private scratch directory;
 * DatabaseSync then VACUUMs that copy into a checked, single-file snapshot.
 * This keeps the legacy source byte-for-byte untouched by SQLite recovery.
 * Hash-verified legacy DSH managed artifacts are archived inside the new
 * private state; the returned rebuildCommand recreates path-bound artifacts.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { compareProcessIdentity, inspectProcessIdentity } from '../process/identity.mjs';
import { privateProjectStateDir, withPrivateProjectStateTransition,
  privateStateBaseDir } from './private-state.mjs';
import { unsafeDirectoryAcl } from './project-trust.mjs';

const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const CREATE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
const MARKER = '.project-root.json';
const WORKER_ARG = '--internal-offline-state-migration-worker';
const MODULE_FILE = fileURLToPath(import.meta.url);

function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function unsafe(message, cause) {
  return failure('STATE_MIGRATION_UNSAFE', message, cause);
}

function uid() {
  if (typeof process.getuid !== 'function' ||
      fs.constants.O_NOFOLLOW === undefined || fs.constants.O_DIRECTORY === undefined) {
    throw unsafe('Offline migration requires POSIX ownership and no-follow operations');
  }
  return BigInt(process.getuid());
}

function mode(stat) { return Number(stat.mode & 0o7777n); }
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function sameContentStat(a, b) {
  return sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}

function statNoFollow(target) {
  try { return fs.lstatSync(target, { bigint: true }); }
  catch (error) { throw unsafe(`Cannot inspect migration source: ${target}`, error); }
}

function checkedDirectory(target, { exactMode = null, tighten = false } = {}) {
  const before = statNoFollow(target);
  if (before.isSymbolicLink() || !before.isDirectory() || before.uid !== uid()) {
    throw unsafe(`Directory must be real and owned by the current user: ${target}`);
  }
  let fd;
  try {
    fd = fs.openSync(target, DIRECTORY_FLAGS);
    let opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || !sameFile(before, opened) || opened.uid !== uid() ||
        unsafeDirectoryAcl(target, opened)) {
      throw unsafe(`Directory changed during validation: ${target}`);
    }
    if (exactMode !== null && mode(opened) !== exactMode) {
      if (!tighten || (mode(opened) & 0o022) !== 0) {
        throw unsafe(`Directory must have mode ${exactMode.toString(8)}: ${target}`);
      }
      fs.fchmodSync(fd, exactMode);
      opened = fs.fstatSync(fd, { bigint: true });
    }
    if (exactMode !== null && mode(opened) !== exactMode) {
      throw unsafe(`Cannot secure directory: ${target}`);
    }
    const after = statNoFollow(target);
    if (after.isSymbolicLink() || !sameFile(opened, after)) {
      throw unsafe(`Directory changed during validation: ${target}`);
    }
    return opened;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function checkedRegular(target) {
  const stat = statNoFollow(target);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid() || stat.nlink !== 1n) {
    throw unsafe(`Source must be a current-user-owned, single-link regular file: ${target}`);
  }
  return stat;
}

function signature(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink, stat.size,
    stat.mtimeNs, stat.ctimeNs].map(String).join(':');
}

function copyRegular(sourceName, destination) {
  const before = checkedRegular(sourceName);
  let input;
  let output;
  try {
    input = fs.openSync(sourceName, READ_FLAGS);
    const opened = fs.fstatSync(input, { bigint: true });
    if (!sameContentStat(before, opened) || !opened.isFile()) {
      throw unsafe(`Source file changed while opening: ${sourceName}`);
    }
    output = fs.openSync(destination, CREATE_FLAGS, 0o600);
    const block = Buffer.allocUnsafe(128 * 1024);
    for (;;) {
      const size = fs.readSync(input, block, 0, block.length, null);
      if (size === 0) break;
      let offset = 0;
      while (offset < size) offset += fs.writeSync(output, block, offset, size - offset);
    }
    fs.fchmodSync(output, 0o600);
    fs.fsyncSync(output);
    const afterOpened = fs.fstatSync(input, { bigint: true });
    const afterPath = checkedRegular(sourceName);
    if (!sameContentStat(before, afterOpened) || !sameContentStat(before, afterPath)) {
      throw unsafe(`Source file changed while copying: ${sourceName}`);
    }
  } finally {
    if (output !== undefined) fs.closeSync(output);
    if (input !== undefined) fs.closeSync(input);
  }
}

function privateMkdir(target) {
  fs.mkdirSync(target, { mode: 0o700 });
  return checkedDirectory(target, { exactMode: 0o700 });
}

function ensurePrivateDirectory(target) {
  try { privateMkdir(target); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    checkedDirectory(target, { exactMode: 0o700, tighten: true });
  }
}

function checkHomeAncestry(home) {
  const parts = [];
  for (let current = home;; current = path.dirname(current)) {
    parts.push(current);
    if (path.dirname(current) === current) break;
  }
  for (const target of parts.reverse()) {
    const stat = statNoFollow(target);
    if (stat.isSymbolicLink() || !stat.isDirectory() || unsafeDirectoryAcl(target, stat) ||
        (stat.uid !== uid() && stat.uid !== 0n) ||
        ((mode(stat) & 0o022) !== 0 && (mode(stat) & 0o1000) === 0)) {
      throw unsafe(`Untrusted home ancestor: ${target}`);
    }
    const fd = fs.openSync(target, DIRECTORY_FLAGS);
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isDirectory() || !sameFile(stat, opened) || opened.uid !== stat.uid) {
        throw unsafe(`Home ancestor changed during validation: ${target}`);
      }
    } finally { fs.closeSync(fd); }
  }
}

function fsyncDirectory(target) {
  const fd = fs.openSync(target, DIRECTORY_FLAGS);
  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function readSmallJson(name) {
  const before = checkedRegular(name);
  if (before.size > 65536n) throw unsafe(`Process evidence is too large: ${name}`);
  const fd = fs.openSync(name, READ_FLAGS);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameContentStat(before, opened)) throw unsafe(`Process evidence changed: ${name}`);
    const raw = fs.readFileSync(fd, 'utf8');
    if (!sameContentStat(before, fs.fstatSync(fd, { bigint: true })) ||
        !sameContentStat(before, checkedRegular(name))) {
      throw unsafe(`Process evidence changed: ${name}`);
    }
    let value;
    try { value = JSON.parse(raw); }
    catch { throw unsafe(`Process evidence is not valid JSON: ${name}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw unsafe(`Process evidence is not an object: ${name}`);
    }
    return value;
  } finally { fs.closeSync(fd); }
}

function assertRecordedProcessDead(pid, stored, label) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw unsafe(`Cannot establish offline state for ${label}: missing PID`);
  }
  const current = inspectProcessIdentity(pid);
  if (current.state === 'dead') return;
  if (current.state === 'live' && stored &&
      compareProcessIdentity(stored, current.identity) === 'dead') return;
  throw unsafe(`Cannot establish offline state for ${label}: process is live or unknown`);
}

function checkPointer(name) {
  const pointer = readSmallJson(name);
  assertRecordedProcessDead(pointer.pid,
    pointer.process_identity || pointer.processIdentity || null, name);
}

function checkBufferMetadata(name) {
  const meta = readSmallJson(name);
  const wrapperPid = meta.wrapper_pid ?? meta.wrapperPid;
  const childPid = meta.pid;
  if (wrapperPid == null && childPid == null) {
    throw unsafe(`Cannot establish PTY owner for ${name}`);
  }
  if (wrapperPid != null) assertRecordedProcessDead(wrapperPid,
    meta.wrapper_identity || meta.wrapperIdentity || null, name);
  if (childPid != null) assertRecordedProcessDead(childPid,
    meta.child_identity || meta.childIdentity || null, name);
}

function quoteIdentifier(value) { return `"${value.replaceAll('"', '""')}"`; }
function quoteSqlString(value) { return `'${value.replaceAll("'", "''")}'`; }

function quickCheckAndCounts(db, label) {
  const results = db.prepare('PRAGMA quick_check').all();
  if (results.length !== 1 || Object.values(results[0])[0] !== 'ok') {
    throw unsafe(`SQLite quick_check failed: ${label}`);
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  return tables.map(({ name }) => [name,
    String(Object.values(db.prepare(`SELECT count(*) FROM ${quoteIdentifier(name)}`).get())[0])]);
}

function checkMeshPeers(db) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'peers'").get();
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(peers)').all().map((row) => row.name);
  if (!columns.includes('pid')) return;
  const hasFingerprint = columns.includes('pid_start_token') && columns.includes('pid_command_hash');
  const rows = db.prepare(`SELECT pid${hasFingerprint ? ', pid_start_token, pid_command_hash' : ''} FROM peers WHERE pid IS NOT NULL`).all();
  for (const row of rows) {
    const stored = hasFingerprint && row.pid_start_token && row.pid_command_hash
      ? { pid: Number(row.pid), startToken: row.pid_start_token, commandHash: row.pid_command_hash }
      : null;
    assertRecordedProcessDead(Number(row.pid), stored, 'mesh peer');
  }
}

function snapshotDatabase(scratchDb, destination, { mesh = false } = {}) {
  let source;
  let target;
  try {
    source = new DatabaseSync(scratchDb, { timeout: 1000 });
    const before = quickCheckAndCounts(source, scratchDb);
    if (mesh) checkMeshPeers(source);
    source.exec(`VACUUM INTO ${quoteSqlString(destination)}`);
    source.close();
    source = null;
    const fd = fs.openSync(destination, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.uid !== uid() || stat.nlink !== 1n) {
        throw unsafe(`SQLite snapshot is not a private regular file: ${destination}`);
      }
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    target = new DatabaseSync(destination, { readOnly: true, timeout: 1000 });
    const after = quickCheckAndCounts(target, destination);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw unsafe(`SQLite row counts changed in snapshot: ${destination}`);
    }
  } finally {
    try { target?.close(); } catch {}
    try { source?.close(); } catch {}
  }
}

function isDatabase(name) { return /\.(?:db|sqlite)$/i.test(name); }
function sidecarBase(name) {
  const match = name.match(/^(.*\.(?:db|sqlite))-(?:wal|shm)$/i);
  return match?.[1] || null;
}

function isRuntimePointer(relativeDir, name) {
  return name === 'runtime.json' && (relativeDir === '' || relativeDir === 'native');
}

function scanSource(stored, relativeDir = '') {
  const current = fs.statSync('.', { bigint: true });
  if (stored && !sameFile(current, stored)) throw unsafe('Anchored source directory changed');
  const names = fs.readdirSync('.').sort();
  for (const name of names) {
    const relative = path.join(relativeDir, name);
    const stat = statNoFollow(name);
    if (stat.isSymbolicLink() || stat.uid !== uid() ||
        (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))) {
      throw unsafe(`Unsupported or unsafe source entry: ${relative}`);
    }
    if (stat.isDirectory()) {
      const before = checkedDirectory(name);
      process.chdir(name);
      try { scanSource(before, relative); }
      finally { process.chdir('..'); }
      if (!sameFile(fs.statSync('.', { bigint: true }), current)) {
        throw unsafe(`Source parent changed during traversal: ${relativeDir}`);
      }
    } else if (isRuntimePointer(relativeDir, name)) {
      checkPointer(name);
    } else if (relativeDir === 'bufs' && name.endsWith('.meta')) {
      checkBufferMetadata(name);
    }
  }
  if (JSON.stringify(names) !== JSON.stringify(fs.readdirSync('.').sort())) {
    throw unsafe(`Source directory changed during traversal: ${relativeDir || '.'}`);
  }
}

function copyDirectory(stage, scratch, summary, relativeDir = '', inventory = new Map(), expected = null) {
  const current = fs.statSync('.', { bigint: true });
  if (expected && !sameFile(current, expected)) {
    throw unsafe(`Anchored source directory changed before copy: ${relativeDir || '.'}`);
  }
  const names = fs.readdirSync('.').sort();
  const namesSet = new Set(names);
  for (const name of names) {
    if (name === MARKER && relativeDir === '') throw unsafe('Legacy state contains a reserved migration marker');
    const relative = path.join(relativeDir, name);
    const stat = statNoFollow(name);
    if (stat.isSymbolicLink() || stat.uid !== uid() ||
        (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))) {
      throw unsafe(`Unsupported or unsafe source entry: ${relative}`);
    }
    inventory.set(relative, signature(stat));
    if (sidecarBase(name) && !namesSet.has(sidecarBase(name))) {
      throw unsafe(`Orphaned SQLite sidecar: ${relative}`);
    }
    if (/\.(?:db|sqlite)-journal$/i.test(name)) {
      throw unsafe(`Rollback journal needs manual recovery before migration: ${relative}`);
    }
  }

  for (const name of names) {
    const relative = path.join(relativeDir, name);
    const stat = statNoFollow(name);
    if (inventory.get(relative) !== signature(stat)) {
      throw unsafe(`Source entry changed before copying: ${relative}`);
    }
    if (stat.isDirectory()) {
      const before = checkedDirectory(name);
      if (inventory.get(relative) !== signature(before)) {
        throw unsafe(`Source directory changed before entering: ${relative}`);
      }
      privateMkdir(path.join(stage, relative));
      privateMkdir(path.join(scratch, relative));
      process.chdir(name);
      try { copyDirectory(stage, scratch, summary, relative, inventory, before); }
      finally { process.chdir('..'); }
      if (!sameFile(current, fs.statSync('.', { bigint: true }))) {
        throw unsafe(`Source parent changed during copy: ${relativeDir || '.'}`);
      }
      if (!sameFile(before, statNoFollow(name))) throw unsafe(`Source directory changed: ${relative}`);
      continue;
    }
    if (isRuntimePointer(relativeDir, name)) {
      checkPointer(name);
      summary.omittedPointers += 1;
      continue;
    }
    if (relativeDir === 'bufs' && name.endsWith('.meta')) checkBufferMetadata(name);
    if (sidecarBase(name)) {
      if (name.endsWith('-wal') && !fs.existsSync(path.join(scratch, relative))) {
        copyRegular(name, path.join(scratch, relative));
      }
      continue;
    }
    if (isDatabase(name)) {
      const scratchDb = path.join(scratch, relative);
      copyRegular(name, scratchDb);
      // The WAL is copied before opening scratch, even when it sorts after DB.
      const wal = `${name}-wal`;
      if (namesSet.has(wal) && !fs.existsSync(path.join(scratch, relativeDir, wal))) {
        copyRegular(wal, path.join(scratch, relativeDir, wal));
      }
      snapshotDatabase(scratchDb, path.join(stage, relative), {
        mesh: relativeDir === '' && name === 'mesh.db'
      });
      summary.databases += 1;
      continue;
    }
    copyRegular(name, path.join(stage, relative));
    summary.files += 1;
  }
  if (JSON.stringify(names) !== JSON.stringify(fs.readdirSync('.').sort())) {
    throw unsafe(`Source directory changed during copy: ${relativeDir || '.'}`);
  }
  return inventory;
}

function confirmInventory(inventory, relativeDir = '', expected = null) {
  const current = fs.statSync('.', { bigint: true });
  if (expected && !sameFile(current, expected)) {
    throw unsafe(`Anchored source directory changed before verification: ${relativeDir || '.'}`);
  }
  const names = fs.readdirSync('.').sort();
  for (const name of names) {
    const relative = path.join(relativeDir, name);
    const stat = statNoFollow(name);
    if (inventory.get(relative) !== signature(stat)) {
      throw unsafe(`Legacy state changed during migration: ${relative}`);
    }
    if (stat.isDirectory()) {
      const before = checkedDirectory(name);
      process.chdir(name);
      try { confirmInventory(inventory, relativeDir ? path.join(relativeDir, name) : name, before); }
      finally { process.chdir('..'); }
      if (!sameFile(current, fs.statSync('.', { bigint: true })) ||
          !sameFile(before, statNoFollow(name))) {
        throw unsafe(`Legacy directory changed during verification: ${relative}`);
      }
    } else if (isRuntimePointer(relativeDir, name)) checkPointer(name);
    else if (relativeDir === 'bufs' && name.endsWith('.meta')) checkBufferMetadata(name);
  }
  if (names.length !== [...inventory.keys()].filter((item) => path.dirname(item) === (relativeDir || '.')).length) {
    throw unsafe(`Legacy directory contents changed: ${relativeDir || '.'}`);
  }
}

function fsyncTree(directory) {
  for (const name of fs.readdirSync(directory)) {
    const child = path.join(directory, name);
    const stat = statNoFollow(child);
    if (stat.isDirectory()) fsyncTree(child);
    else if (stat.isFile() && !stat.isSymbolicLink()) {
      const fd = fs.openSync(child, READ_FLAGS);
      try { fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    } else throw unsafe(`Unexpected staged entry: ${child}`);
  }
  fsyncDirectory(directory);
}

function archiveManagedDsh(stage, canonicalRoot) {
  const directory = path.join(stage, 'dsh');
  const directoryStat = existing(directory);
  if (!directoryStat) return null;
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw unsafe('Staged DSH directory is not a real directory');
  }
  const names = ['hooks.json', 'cordis.patch.yml', 'managed.json'];
  const present = names.filter((name) => existing(path.join(directory, name)));
  if (present.length === 0) return null;
  if (!present.includes('managed.json')) {
    throw unsafe('DSH artifacts lack a managed manifest; preserve them manually before migration');
  }
  const manifest = readSmallJson(path.join(directory, 'managed.json'));
  const mode = manifest.mode === undefined ? 'hooks' : manifest.mode;
  if (manifest.managedBy !== 'hello-cc/dsh' || manifest.schema !== 1 ||
      manifest.root !== canonicalRoot || !['hooks', 'cordis', 'off'].includes(mode) ||
      !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files) ||
      typeof manifest.hccBin !== 'string' || !path.isAbsolute(manifest.hccBin) ||
      typeof manifest.nodeBin !== 'string' || !path.isAbsolute(manifest.nodeBin)) {
    throw unsafe('DSH managed manifest cannot be verified');
  }
  for (const name of present.filter((value) => value !== 'managed.json')) {
    const file = path.join(directory, name);
    checkedRegular(file);
    const fd = fs.openSync(file, READ_FLAGS);
    let bytes;
    try { bytes = fs.readFileSync(fd); }
    finally { fs.closeSync(fd); }
    const expected = manifest.files[name];
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || expected !== actual) {
      throw unsafe(`DSH managed artifact differs from its manifest: ${name}`);
    }
    if (name === 'hooks.json') {
      let hooks;
      try { hooks = JSON.parse(bytes.toString('utf8')); }
      catch { throw unsafe('DSH managed hooks are invalid JSON'); }
      if (hooks?._helloCc?.managedBy !== 'hello-cc/dsh' || hooks?._helloCc?.schema !== 1) {
        throw unsafe('DSH hooks do not have the expected hello-cc ownership marker');
      }
    }
  }
  const archiveName = `.legacy-managed-${randomBytes(8).toString('hex')}`;
  const archive = path.join(directory, archiveName);
  privateMkdir(archive);
  for (const name of present) fs.renameSync(path.join(directory, name), path.join(archive, name));
  fsyncDirectory(archive);
  fsyncDirectory(directory);
  return { mode, archiveName, rebuildCommand: `hcc dsh setup --mode ${mode}` };
}

function worker({ source, sourceDev, sourceIno, stage, stageDev, stageIno, globalPointer, canonicalRoot }) {
  process.umask(0o077);
  const sourceStat = checkedDirectory(source, { exactMode: 0o700 });
  const stageStat = checkedDirectory(stage, { exactMode: 0o700 });
  if (String(sourceStat.dev) !== sourceDev || String(sourceStat.ino) !== sourceIno ||
      String(stageStat.dev) !== stageDev || String(stageStat.ino) !== stageIno) {
    throw unsafe('Migration source or staging directory changed before worker start');
  }
  process.chdir(source);
  if (!sameFile(fs.statSync('.', { bigint: true }), sourceStat)) {
    throw unsafe('Could not anchor the legacy state directory');
  }
  if (existing(globalPointer)) checkPointer(globalPointer);
  scanSource(sourceStat);
  const scratch = path.join(stage, '.sqlite-work');
  privateMkdir(scratch);
  const summary = { databases: 0, files: 0, omittedPointers: 0 };
  const inventory = copyDirectory(stage, scratch, summary, '', new Map(), sourceStat);
  confirmInventory(inventory, '', sourceStat);
  scanSource(sourceStat);
  if (existing(globalPointer)) checkPointer(globalPointer);
  fs.rmSync(scratch, { recursive: true, force: false });
  summary.dsh = archiveManagedDsh(stage, canonicalRoot);
  fsyncTree(stage);
  return summary;
}

function assertCallerOffline(assertOffline, phase) {
  if (typeof assertOffline !== 'function' || assertOffline({ phase }) !== true) {
    throw failure('STATE_MIGRATION_OFFLINE_REQUIRED',
      `Caller must assert all legacy state producers are stopped (${phase})`);
  }
}

function sourceIdentity(root) {
  const canonicalRoot = fs.realpathSync(root);
  const rootStat = fs.statSync(canonicalRoot, { bigint: true });
  if (!rootStat.isDirectory()) throw unsafe(`Project root is not a directory: ${root}`);
  const source = path.join(canonicalRoot, '.hello-cc');
  const sourceStat = checkedDirectory(source, { exactMode: 0o700 });
  return { canonicalRoot, rootStat, source, sourceStat };
}

function markerBody(project) {
  return JSON.stringify({
    version: 1,
    canonicalRoot: project.canonicalRoot,
    dev: String(project.rootStat.dev),
    ino: String(project.rootStat.ino)
  }) + '\n';
}

function writeMarker(stage, project) {
  const marker = path.join(stage, MARKER);
  const body = markerBody(project);
  const fd = fs.openSync(marker, CREATE_FLAGS, 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fsyncDirectory(stage);
}

function writeAuthorityMarker(projects, setAuthorityKind) {
  const marker = setAuthorityKind('migrated');
  fsyncDirectory(projects);
  return marker;
}

function existing(target) {
  try { return fs.lstatSync(target, { bigint: true }); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

/**
 * Migrate only after explicit human confirmation and the caller's own offline
 * assertion. Returns the new path and copied-file counts. Existing private
 * state is never overwritten. Source runtime pointers are verified but omitted
 * because their endpoints and tokens refer to the old location.
 * A returned dsh.rebuildCommand must be run before using a migrated DSH setup.
 */
export function migrateLegacyProjectState(root, { confirmedOffline = false, assertOffline } = {}) {
  if (confirmedOffline !== true) {
    throw failure('STATE_MIGRATION_OFFLINE_REQUIRED', 'Explicit offline migration confirmation is required');
  }
  assertCallerOffline(assertOffline, 'before');
  const project = sourceIdentity(root);
  const base = privateStateBaseDir();
  const destination = privateProjectStateDir(project.canonicalRoot);
  const projects = path.dirname(destination);
  if (project.source === base || projects.startsWith(`${project.source}${path.sep}`)) {
    throw unsafe('Legacy source overlaps private destination');
  }
  checkHomeAncestry(path.dirname(base));
  ensurePrivateDirectory(base);
  ensurePrivateDirectory(projects);
  return withPrivateProjectStateTransition(project.canonicalRoot, ({ setAuthorityKind }) => {
  const projectsStat = checkedDirectory(projects, { exactMode: 0o700 });
  if (existing(destination)) {
    throw failure('STATE_MIGRATION_EXISTS', `Private project state already exists: ${destination}`);
  }
  const stage = path.join(projects, `.${path.basename(destination)}.migration-${randomBytes(12).toString('hex')}`);
  const stageStat = privateMkdir(stage);
  let committed = false;
  try {
    const result = spawnSync(process.execPath, [MODULE_FILE, WORKER_ARG, JSON.stringify({
      source: project.source,
      sourceDev: String(project.sourceStat.dev),
      sourceIno: String(project.sourceStat.ino),
      stage,
      stageDev: String(stageStat.dev),
      stageIno: String(stageStat.ino),
      globalPointer: path.join(base, 'runtime.json'),
      canonicalRoot: project.canonicalRoot
    })], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    let message;
    try { message = JSON.parse(result.stdout); } catch {}
    if (result.error || result.status !== 0 || !message?.ok) {
      throw failure(message?.code || 'STATE_MIGRATION_FAILED',
        message?.error || result.error?.message || result.stderr?.trim() || 'Migration worker failed', result.error);
    }
    assertCallerOffline(assertOffline, 'after');
    const sourceNow = checkedDirectory(project.source, { exactMode: 0o700 });
    const rootNow = fs.statSync(project.canonicalRoot, { bigint: true });
    if (!sameFile(sourceNow, project.sourceStat) || !sameFile(rootNow, project.rootStat)) {
      throw unsafe('Project root or legacy state changed before commit');
    }
    if (!sameFile(checkedDirectory(stage, { exactMode: 0o700 }), stageStat)) {
      throw unsafe('Migration staging directory changed before commit');
    }
    if (!sameFile(checkedDirectory(projects, { exactMode: 0o700 }), projectsStat)) {
      throw unsafe('Private projects directory changed before commit');
    }
    writeMarker(stage, project);
    // Persist authority before exposing the destination. If the rename fails,
    // the marker makes future access fail closed until an explicit retry.
    writeAuthorityMarker(projects, setAuthorityKind);
    if (existing(destination)) {
      throw failure('STATE_MIGRATION_EXISTS', `Private project state appeared during migration: ${destination}`);
    }
    fsyncDirectory(projects);
    fs.renameSync(stage, destination);
    try {
      fsyncDirectory(projects);
    } catch (error) {
      try {
        fs.renameSync(destination, stage);
        fsyncDirectory(projects);
      } catch (rollbackError) {
        throw failure('STATE_MIGRATION_COMMIT_UNCERTAIN',
          `Cannot confirm or roll back migration commit at ${destination}`, rollbackError);
      }
      throw failure('STATE_MIGRATION_FAILED', 'Could not durably commit private project state', error);
    }
    committed = true;
    const summary = message.summary;
    if (summary.dsh) {
      summary.dsh.archivePath = path.join(destination, 'dsh', summary.dsh.archiveName);
    }
    return { stateDir: destination, sourceDir: project.source, ...summary };
  } finally {
    if (!committed) {
      try {
        const current = existing(stage);
        if (current && current.isDirectory() && sameFile(current, stageStat)) {
          fs.rmSync(stage, { recursive: true, force: false });
          fsyncDirectory(projects);
        }
      } catch { /* Preserve the original error; an uncommitted stage is inert. */ }
    }
  }
  });
}

if (process.argv[1] === MODULE_FILE && process.argv[2] === WORKER_ARG) {
  try {
    const summary = worker(JSON.parse(process.argv[3]));
    process.stdout.write(JSON.stringify({ ok: true, summary }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error?.code || 'STATE_MIGRATION_FAILED',
      error: error?.message || 'Migration failed' }));
    process.exitCode = 1;
  }
}
