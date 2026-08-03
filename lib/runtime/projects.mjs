import fs from 'node:fs';
import path from 'node:path';
import { projectDbPath, projectRegistryPath } from './paths.mjs';
import { withFileLock } from '../shared/file-lock.mjs';
import { writeJsonSafe } from '../shared/json-file.mjs';

const ROOT_EXISTS = Symbol('projectRootExists');
const ROOT_WAS_CANONICAL = Symbol('projectRootWasCanonical');
const RAW_ROOT = Symbol('projectRawRoot');
const TIMESTAMP_VALID = Symbol('projectTimestampValid');

function registryTimestamp(nowFn = () => Math.floor(Date.now() / 1000)) {
  return nowFn();
}

function sameFilesystemObject(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function missingPath(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function invalidProjectRoot(message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'ERR_INVALID_PROJECT_ROOT';
  return error;
}

function invalidProjectDb(message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'ERR_INVALID_PROJECT_DB';
  return error;
}

function pathWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) &&
    relative !== '..' && !path.isAbsolute(relative));
}

function normalizedTimestamp(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return { value, valid: true };
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return { value: parsed, valid: true };
  }
  return { value: 0, valid: false };
}

function canonicalProjectRoot(value, { requireExisting = false } = {}) {
  const resolved = path.resolve(value);
  let before;
  try {
    before = fs.statSync(resolved);
  } catch (error) {
    if (missingPath(error) && !requireExisting) {
      return { root: resolved, exists: false };
    }
    if (requireExisting) {
      throw invalidProjectRoot(`project root is not an existing directory: ${resolved}`, error);
    }
    return null;
  }
  if (!before.isDirectory()) {
    if (requireExisting) throw invalidProjectRoot(`project root is not a directory: ${resolved}`);
    return null;
  }

  try {
    const canonical = fs.realpathSync.native(resolved);
    const canonicalStat = fs.statSync(canonical);
    const after = fs.statSync(resolved);
    const confirmed = fs.realpathSync.native(resolved);
    if (!canonicalStat.isDirectory() || !after.isDirectory() ||
        canonical !== confirmed ||
        !sameFilesystemObject(before, canonicalStat) ||
        !sameFilesystemObject(before, after)) {
      throw invalidProjectRoot(`project root changed during canonicalization: ${resolved}`);
    }
    return { root: canonical, exists: true };
  } catch (error) {
    if (requireExisting) {
      if (error?.code === 'ERR_INVALID_PROJECT_ROOT') throw error;
      throw invalidProjectRoot(`project root changed during canonicalization: ${resolved}`, error);
    }
    return null;
  }
}

function canonicalProjectDb(value, rawRoot, rootInfo, { strict = false } = {}) {
  function reject(message, cause = null) {
    if (strict) throw invalidProjectDb(message, cause);
    return null;
  }

  const rawDb = path.resolve(value);
  const relativeToRawRoot = path.relative(rawRoot, rawDb);
  const db = pathWithin(rawRoot, rawDb)
    ? path.resolve(rootInfo.root, relativeToRawRoot)
    : rawDb;

  if (!rootInfo.exists) {
    return pathWithin(rootInfo.root, db)
      ? db
      : reject(`project DB is outside the project root: ${rawDb}`);
  }

  let ancestor = db;
  let before;
  while (true) {
    try {
      before = fs.statSync(ancestor);
      break;
    } catch (error) {
      if (!missingPath(error)) {
        return reject(`project DB path cannot be resolved safely: ${rawDb}`, error);
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        return reject(`project DB path has no existing parent: ${rawDb}`, error);
      }
      ancestor = parent;
    }
  }

  const dbExists = ancestor === db;
  if ((dbExists && before.isDirectory()) || (!dbExists && !before.isDirectory())) {
    return reject(`project DB path is not a file under an existing directory: ${rawDb}`);
  }

  try {
    const canonicalAncestor = fs.realpathSync.native(ancestor);
    const canonicalStat = fs.statSync(canonicalAncestor);
    const after = fs.statSync(ancestor);
    const confirmed = fs.realpathSync.native(ancestor);
    if (canonicalAncestor !== confirmed ||
        !sameFilesystemObject(before, canonicalStat) ||
        !sameFilesystemObject(before, after) ||
        (dbExists ? canonicalStat.isDirectory() : !canonicalStat.isDirectory())) {
      return reject(`project DB path changed during canonicalization: ${rawDb}`);
    }
    const canonicalDb = dbExists
      ? canonicalAncestor
      : path.resolve(canonicalAncestor, path.relative(ancestor, db));
    if (!pathWithin(rootInfo.root, canonicalDb)) {
      return reject(`project DB is outside the project root: ${rawDb}`);
    }
    return canonicalDb;
  } catch (error) {
    if (error?.code === 'ERR_INVALID_PROJECT_DB') throw error;
    return reject(`project DB path changed during canonicalization: ${rawDb}`, error);
  }
}

function normalizeProjectEntry(project, options = {}) {
  if (!project?.root) return null;
  const rawRoot = project[RAW_ROOT] || path.resolve(project.root);
  const rootInfo = canonicalProjectRoot(project.root, options);
  if (!rootInfo) return null;
  const db = canonicalProjectDb(
    project.db || projectDbPath(rawRoot),
    rawRoot,
    rootInfo,
    { strict: options.requireExisting === true }
  );
  if (!db) return null;
  if (rootInfo.exists) {
    const confirmedRoot = canonicalProjectRoot(project.root, options);
    if (!confirmedRoot || !confirmedRoot.exists || confirmedRoot.root !== rootInfo.root) {
      if (options.requireExisting) {
        throw invalidProjectRoot(`project root changed during DB canonicalization: ${rawRoot}`);
      }
      return null;
    }
  }
  const timestamp = project[TIMESTAMP_VALID] === undefined
    ? normalizedTimestamp(project.last_seen_at)
    : { value: project.last_seen_at, valid: project[TIMESTAMP_VALID] };
  const row = {
    root: rootInfo.root,
    db,
    name: String(project.name || path.basename(rootInfo.root) || rootInfo.root),
    last_seen_at: timestamp.value
  };
  Object.defineProperty(row, ROOT_EXISTS, { value: rootInfo.exists });
  Object.defineProperty(row, ROOT_WAS_CANONICAL, {
    value: project[ROOT_WAS_CANONICAL] ?? rawRoot === rootInfo.root
  });
  Object.defineProperty(row, RAW_ROOT, { value: rawRoot });
  Object.defineProperty(row, TIMESTAMP_VALID, { value: timestamp.valid });
  return row;
}

function preferLexicallySmaller(left, right) {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

function compareProjectPreference(left, right) {
  if (left[TIMESTAMP_VALID] !== right[TIMESTAMP_VALID]) {
    return left[TIMESTAMP_VALID] ? 1 : -1;
  }
  if (left.last_seen_at !== right.last_seen_at) {
    return left.last_seen_at > right.last_seen_at ? 1 : -1;
  }
  if (left[ROOT_WAS_CANONICAL] !== right[ROOT_WAS_CANONICAL]) {
    return left[ROOT_WAS_CANONICAL] ? 1 : -1;
  }
  return preferLexicallySmaller(left.db, right.db) ||
    preferLexicallySmaller(left.name, right.name) ||
    preferLexicallySmaller(left[RAW_ROOT], right[RAW_ROOT]);
}

function normalizedProjectRows(projects, requiredRoots = new Set()) {
  const unique = new Map();
  for (const project of projects) {
    const resolvedRoot = project?.root ? path.resolve(project.root) : null;
    const row = normalizeProjectEntry(project, {
      requireExisting: resolvedRoot !== null && requiredRoots.has(resolvedRoot)
    });
    if (!row) continue;
    const current = unique.get(row.root);
    if (!current || compareProjectPreference(row, current) > 0) unique.set(row.root, row);
  }
  return [...unique.values()].sort((a, b) => (b.last_seen_at || 0) - (a.last_seen_at || 0));
}

function persistProjectRegistry(file, projects, options = {}) {
  const rows = normalizedProjectRows(projects, options.requiredRoots);
  writeJsonSafe(file, { projects: rows }, { mode: 0o600 });
  return rows;
}

function lexicalProjectRecord(ctx, nowFn) {
  const root = path.resolve(ctx.root);
  return {
    root,
    db: path.resolve(ctx.dbPath || projectDbPath(root)),
    name: path.basename(root) || root,
    last_seen_at: registryTimestamp(nowFn)
  };
}

export function projectRecord(ctx, nowFn) {
  return normalizeProjectEntry(lexicalProjectRecord(ctx, nowFn), { requireExisting: true });
}

function readProjectRegistryFrom(file) {
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(parsed?.projects) ? parsed.projects : [];
    return normalizedProjectRows(rows.filter((p) => p && typeof p.root === 'string'))
      .filter((project) => project?.[ROOT_EXISTS]);
  } catch {
    return [];
  }
}

export function readProjectRegistry() {
  return readProjectRegistryFrom(projectRegistryPath());
}

export function writeProjectRegistry(projects) {
  // Atomic temp+rename write so concurrent readers never see a half-written
  // registry (avoids the interleaved read-modify-write clobber in bg-06).
  return persistProjectRegistry(projectRegistryPath(), projects);
}

const REGISTRY_WRITE_THROTTLE_SEC = 60;
const ACTIVITY_LOCK_THROTTLE_MS = 60_000;
const ACTIVITY_FAILURE_BACKOFF_MS = 250;
const ACTIVITY_CACHE_LIMIT = 1024;
const recentActivityLocks = new Map();

function updateProjectRegistry(candidate, lockOptions = {}) {
  const registryPath = projectRegistryPath();
  return withFileLock(registryPath, (lockedRegistryPath) => {
    const existing = readProjectRegistryFrom(lockedRegistryPath);
    // Web requests touch this path frequently. Suppress only an identical
    // root+DB refresh; changing the DB binding must be persisted immediately.
    const row = existing.find((project) => project.root === candidate.root);
    const ageSeconds = row ? registryTimestamp() - (row.last_seen_at || 0) : null;
    if (row && row.db === candidate.db &&
        ageSeconds >= 0 && ageSeconds < REGISTRY_WRITE_THROTTLE_SEC) {
      return existing;
    }
    const rows = existing.filter((project) => project.root !== candidate.root);
    rows.unshift(candidate);
    return persistProjectRegistry(
      lockedRegistryPath,
      rows,
      { requiredRoots: new Set([candidate.root]) }
    );
  }, lockOptions);
}

export function registerProject(ctx) {
  const candidate = projectRecord(ctx);
  if (!candidate) throw new TypeError('project root is required');
  return updateProjectRegistry(candidate);
}

export function registerProjectActivity(ctx) {
  try {
    const wallTimestamp = Date.now();
    const candidate = projectRecord(ctx, () => Math.floor(wallTimestamp / 1000));
    if (!candidate) return;
    const key = candidate.root;
    const now = Number(process.hrtime.bigint() / 1_000_000n);
    const previous = recentActivityLocks.get(key);
    const previousWindow = previous?.succeeded
      ? ACTIVITY_LOCK_THROTTLE_MS
      : ACTIVITY_FAILURE_BACKOFF_MS;
    if (previous?.db === candidate.db &&
        wallTimestamp >= previous.wallTimestamp &&
        now - previous.timestamp < previousWindow) return;

    for (const [cachedKey, cached] of recentActivityLocks) {
      const window = cached.succeeded
        ? ACTIVITY_LOCK_THROTTLE_MS
        : ACTIVITY_FAILURE_BACKOFF_MS;
      if (now - cached.timestamp >= window) recentActivityLocks.delete(cachedKey);
    }
    if (recentActivityLocks.size >= ACTIVITY_CACHE_LIMIT) {
      recentActivityLocks.delete(recentActivityLocks.keys().next().value);
    }
    try {
      updateProjectRegistry(candidate, { nonblocking: true });
      recentActivityLocks.set(key, {
        db: candidate.db,
        wallTimestamp,
        timestamp: now,
        succeeded: true
      });
    } catch {
      // Avoid hammering the lock endpoint on every HTTP request while ensuring one
      // busy attempt cannot suppress the first registry write for a minute.
      recentActivityLocks.set(key, {
        db: candidate.db,
        wallTimestamp,
        timestamp: now,
        succeeded: false
      });
    }
  } catch {}
}
