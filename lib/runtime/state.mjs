import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { CliError } from '../shared/errors.mjs';
import { writeJsonSafe } from '../shared/json-file.mjs';
import {
  globalRuntimePath,
  runtimePath
} from './paths.mjs';
import { runtimeApiUrl } from '../web/runtime.mjs';
import { API_VERSION, withRuntimeApiVersionHeader } from '../web/api-version.mjs';

const DEFAULT_PRODUCT_NAME = 'hello-cc';
const DEFAULT_CLI_NAME = 'hcc';

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
  writeJsonSafe(file, runtime, { mode: 0o600 });
  return file;
}

export function writeRuntime(ctx, runtime) {
  const file = runtimePath(ctx);
  writeJsonSafe(file, runtime, { mode: 0o600 });
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
      if (runtime.pid && !pidAlive(runtime.pid)) throw new Error('runtime pid not alive');
      return { ...runtime, source: file };
    } catch {
      // Do not delete on a torn/partial read; fall through to the global
      // runtime and let health probing / restart reclaim a truly dead file.
    }
  }
  if (!localOnly) {
    const global = readGlobalRuntimeFile();
    if (global?.base_url && pidAlive(global.pid)) {
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
  const url = runtimeApiUrl(runtime, '/api/runtime');
  const headers = withRuntimeApiVersionHeader();
  if (runtime.token) headers.Authorization = `Bearer ${runtime.token}`;
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return false;
    const metadata = await response.json();
    return metadata?.api_version === API_VERSION;
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
  if (fs.existsSync(file)) {
    try {
      const runtime = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!runtime.pid || runtime.pid === pid) fs.rmSync(file, { force: true });
    } catch {
      // Leave an unparseable pointer in place: only remove when we can confirm
      // it belongs to this pid, so a torn write never deletes another runtime's file.
    }
  }
  const globalFile = globalRuntimePath();
  if (!fs.existsSync(globalFile)) return;
  try {
    const runtime = JSON.parse(fs.readFileSync(globalFile, 'utf8'));
    if (!runtime.pid || runtime.pid === pid) fs.rmSync(globalFile, { force: true });
  } catch {
    // Same as above: do not blind-delete a torn global runtime pointer.
  }
}
