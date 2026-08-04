import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { compareProcessIdentity, inspectProcessIdentity } from '../process/identity.mjs';
import { CliError } from '../shared/errors.mjs';
import { withFileLock } from '../shared/file-lock.mjs';
import { writeJsonSafe } from '../shared/json-file.mjs';
import {
  globalRuntimePath,
  runtimePath
} from './paths.mjs';
import { runtimeHttpRequest } from '../web/runtime.mjs';
import { API_VERSION } from '../web/api-version.mjs';

const DEFAULT_PRODUCT_NAME = 'hello-cc';
const DEFAULT_CLI_NAME = 'hcc';
export const RUNTIME_POINTER_UNKNOWN_GRACE_MS = 120_000;

function completeProcessIdentity(value) {
  return compareProcessIdentity(value, value) === 'live';
}

export function runtimeProcessIdentity({
  pid = process.pid,
  inspect = inspectProcessIdentity
} = {}) {
  const observed = inspect(pid);
  return observed?.state === 'live' && completeProcessIdentity(observed.identity)
    ? observed.identity
    : null;
}

export function classifyRuntimePointer(runtime, {
  inspect = inspectProcessIdentity,
  ageMs = 0,
  unknownGraceMs = RUNTIME_POINTER_UNKNOWN_GRACE_MS
} = {}) {
  if (!Number.isFinite(ageMs) || ageMs < 0 ||
      !Number.isFinite(unknownGraceMs) || unknownGraceMs < 0) {
    throw new TypeError('runtime pointer ages must be non-negative finite numbers');
  }
  const pid = Number(runtime?.pid);
  const stored = runtime?.process_identity || runtime?.processIdentity || null;
  if (!Number.isInteger(pid) || pid <= 0 || !completeProcessIdentity(stored) || stored.pid !== pid) {
    return { state: 'unknown', reclaimable: ageMs >= unknownGraceMs };
  }
  const current = inspect(pid);
  if (current?.state === 'dead') return { state: 'dead', reclaimable: true };
  if (current?.state !== 'live' || !completeProcessIdentity(current.identity)) {
    return { state: 'unknown', reclaimable: ageMs >= unknownGraceMs };
  }
  return compareProcessIdentity(stored, current.identity) === 'live'
    ? { state: 'alive', reclaimable: false }
    : { state: 'dead', reclaimable: true };
}

function runtimePointerAge(stat, currentMs, unknownGraceMs) {
  const timestampMs = Math.floor(Math.max(Number(stat.mtimeMs), Number(stat.ctimeMs)));
  if (!Number.isFinite(currentMs) || !Number.isFinite(timestampMs)) {
    throw new TypeError('runtime pointer timestamps must be finite numbers');
  }
  return {
    ageMs: currentMs < timestampMs ? 0 : currentMs - timestampMs,
    cutoffSec: Math.max(0, Math.floor(timestampMs / 1000) + Math.ceil(unknownGraceMs / 1000))
  };
}

export function reclaimRuntimePointerFiles(files, {
  nowMs = Date.now,
  inspect = inspectProcessIdentity,
  unknownGraceMs = RUNTIME_POINTER_UNKNOWN_GRACE_MS,
  reclaimUnknown = true,
  dryRun = false,
  onReclaim = null,
  withLock = withFileLock
} = {}) {
  if (typeof reclaimUnknown !== 'boolean') {
    throw new TypeError('reclaimUnknown must be a boolean');
  }
  let blocked = false;
  let reclaimed = 0;
  const outcomes = [];
  for (const suppliedFile of new Set((files || []).map((file) => path.resolve(file)))) {
    if (!fs.existsSync(suppliedFile)) continue;
    let recorded = false;
    const record = (outcome) => {
      recorded = true;
      outcomes.push({ file: suppliedFile, ...outcome });
    };
    try {
      withLock(suppliedFile, (file) => {
        if (!fs.existsSync(file)) {
          record({ state: 'missing', action: 'skipped' });
          return;
        }
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          blocked = true;
          record({ state: 'unknown', action: 'blocked', reason: 'invalid_pointer' });
          return;
        }
        const raw = fs.readFileSync(file, 'utf8');
        let runtime = null;
        try { runtime = JSON.parse(raw); } catch {}
        const timing = runtimePointerAge(stat, nowMs(), unknownGraceMs);
        const evidence = classifyRuntimePointer(runtime, {
          inspect,
          ageMs: timing.ageMs,
          unknownGraceMs
        });
        if (!evidence.reclaimable || (evidence.state === 'unknown' && !reclaimUnknown)) {
          blocked = true;
          record({ state: evidence.state, action: 'blocked', reason: 'owner_not_confirmed_dead' });
          return;
        }
        const current = fs.lstatSync(file);
        const currentRaw = fs.readFileSync(file, 'utf8');
        if (current.isSymbolicLink() || !current.isFile() ||
            current.dev !== stat.dev || current.ino !== stat.ino ||
            current.size !== stat.size || current.mtimeMs !== stat.mtimeMs ||
            current.ctimeMs !== stat.ctimeMs || currentRaw !== raw) {
          blocked = true;
          record({ state: 'unknown', action: 'blocked', reason: 'pointer_changed' });
          return;
        }
        if (!dryRun) fs.unlinkSync(file);
        reclaimed += 1;
        record({ state: evidence.state, action: dryRun ? 'would-reclaim' : 'reclaimed' });
        onReclaim?.({
          file,
          state: evidence.state,
          gcCutoff: evidence.state === 'unknown' ? timing.cutoffSec : null
        });
      });
    } catch {
      blocked = true;
      if (!recorded) record({ state: 'unknown', action: 'blocked', reason: 'lock_unavailable' });
    }
  }
  return { blocked, reclaimed, outcomes };
}

// A runtime pointer carries the runtime process pid. If that pid is no longer
// alive, the pointer is stale and must not be returned as a reachable runtime
// (bg-01): otherwise commands and shims fail against a dead runtime until
// someone manually clears the file. A pointer without a pid is left alone
// (we cannot determine liveness, so keep the previous behavior).
function pidAlive(pid) {
  if (pid === undefined || pid === null || pid === '') return true;
  const numeric = Number(pid);
  if (!Number.isInteger(numeric)) return true;
  try { process.kill(numeric, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function runtimePointerMatchesCurrentProcess(runtime) {
  const stored = runtime?.process_identity || runtime?.processIdentity || null;
  if (!completeProcessIdentity(stored)) return pidAlive(runtime?.pid);
  const pid = Number(runtime?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || stored.pid !== pid) return false;
  return classifyRuntimePointer(runtime, { ageMs: 0 }).state === 'alive';
}

function runtimeMetadataMatchesPointer(runtime, metadata) {
  if (typeof runtime?.product === 'string' && runtime.product &&
      metadata?.product !== runtime.product) return false;
  const stored = runtime?.process_identity || runtime?.processIdentity || null;
  if (!completeProcessIdentity(stored)) return true;
  const pointerPid = Number(runtime?.pid);
  const metadataPid = Number(metadata?.pid);
  const observed = metadata?.process_identity || metadata?.processIdentity || null;
  return Number.isInteger(pointerPid) && pointerPid > 0 && stored.pid === pointerPid &&
    metadataPid === pointerPid && completeProcessIdentity(observed) &&
    observed.pid === metadataPid && compareProcessIdentity(stored, observed) === 'live';
}

export function readGlobalRuntimeFile() {
  const file = globalRuntimePath();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Do not delete on a parse failure: a torn/partial write must not orphan a
    // healthy runtime pointer. Leave it for health probing / restart to reclaim.
    return null;
  }
}

export function writeGlobalRuntime(runtime) {
  const file = globalRuntimePath();
  withFileLock(file, (lockedFile) => writeJsonSafe(lockedFile, runtime, { mode: 0o600 }));
  return file;
}

export function writeRuntime(ctx, runtime) {
  const file = runtimePath(ctx);
  withFileLock(file, (lockedFile) => writeJsonSafe(lockedFile, runtime, { mode: 0o600 }));
  return file;
}

export function readRuntime(ctx, opts = {}) {
  const localOnly = Boolean(opts.localOnly || process.env.HCC_RUNTIME_LOCAL_ONLY === '1');
  if (process.env.HCC_RUNTIME_URL) {
    return {
      base_url: process.env.HCC_RUNTIME_URL,
      token: process.env.HCC_RUNTIME_TOKEN || '',
      source: 'env'
    };
  }
  const file = runtimePath(ctx);
  if (fs.existsSync(file)) {
    try {
      const runtime = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!runtime.base_url) throw new Error('missing base_url');
      if (!runtimePointerMatchesCurrentProcess(runtime)) {
        throw new Error('runtime process identity does not match');
      }
      return { ...runtime, source: file };
    } catch {
      // Do not delete on a torn/partial read; fall through to the global
      // runtime and let health probing / restart reclaim a truly dead file.
    }
  }
  if (!localOnly) {
    const global = readGlobalRuntimeFile();
    if (global?.base_url && runtimePointerMatchesCurrentProcess(global)) {
      return { ...global, source: globalRuntimePath(), global: true };
    }
  }
  const productName = opts.productName || DEFAULT_PRODUCT_NAME;
  const cliName = opts.cliName || DEFAULT_CLI_NAME;
  throw new CliError('RUNTIME_NOT_RUNNING',
    `No running ${productName} web runtime found. Start it with:\n  ${cliName} web`);
}

export function readRuntimeFile(ctx) {
  const file = runtimePath(ctx);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function probeRuntime(runtime) {
  if (!runtime?.base_url) return false;
  const headers = {};
  if (runtime.token) headers.Authorization = `Bearer ${runtime.token}`;
  try {
    const response = await runtimeHttpRequest(runtime, '/api/runtime', { headers, timeoutMs: 3000 });
    if (!response.ok) return false;
    const metadata = JSON.parse(response.text);
    return metadata?.api_version === API_VERSION && runtimeMetadataMatchesPointer(runtime, metadata);
  } catch {
    return false;
  }
}

export async function readHealthyRuntime(ctx) {
  try {
    const runtime = readRuntimeFile(ctx);
    if (runtime && await probeRuntime(runtime)) return runtime;
    const global = readGlobalRuntimeFile();
    if (global && await probeRuntime(global)) return global;
    return null;
  } catch {
    return null;
  }
}

export async function readHealthyGlobalRuntime() {
  try {
    const runtime = readGlobalRuntimeFile();
    if (!runtime) return null;
    return await probeRuntime(runtime) ? runtime : null;
  } catch {
    return null;
  }
}

export function clearRuntime(ctx, pid = process.pid) {
  const file = runtimePath(ctx);
  try {
    withFileLock(file, (lockedFile) => {
      if (!fs.existsSync(lockedFile)) return;
      try {
        const runtime = JSON.parse(fs.readFileSync(lockedFile, 'utf8'));
        if (runtime.pid === pid) fs.rmSync(lockedFile, { force: true });
      } catch {
        // Leave an unparseable pointer in place: only remove when we can confirm
        // it belongs to this pid, so a torn write never deletes another runtime's file.
      }
    });
  } catch {}
  const globalFile = globalRuntimePath();
  try {
    withFileLock(globalFile, (lockedFile) => {
      if (!fs.existsSync(lockedFile)) return;
      try {
        const runtime = JSON.parse(fs.readFileSync(lockedFile, 'utf8'));
        if (runtime.pid === pid) fs.rmSync(lockedFile, { force: true });
      } catch {
        // Same as above: do not blind-delete a torn global runtime pointer.
      }
    });
  } catch {}
}
