import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { CliError } from '../errors.mjs';
import {
  globalRuntimePath,
  runtimePath
} from './paths.mjs';
import { runtimeApiUrl } from '../web/runtime.mjs';

const DEFAULT_PRODUCT_NAME = 'hello-cc';
const DEFAULT_CLI_NAME = 'hcc';

export function readGlobalRuntimeFile() {
  const file = globalRuntimePath();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    try { fs.rmSync(file, { force: true }); } catch {}
    return null;
  }
}

export function writeGlobalRuntime(runtime) {
  const file = globalRuntimePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(runtime, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function writeRuntime(ctx, runtime) {
  const file = runtimePath(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(runtime, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function readRuntime(ctx, opts = {}) {
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
      return { ...runtime, source: file };
    } catch {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
  const global = readGlobalRuntimeFile();
  if (global?.base_url) {
    return { ...global, source: globalRuntimePath(), global: true };
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
  const headers = {};
  if (runtime.token) headers.Authorization = `Bearer ${runtime.token}`;
  try {
    const response = await fetch(url, { headers });
    return response.ok;
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
      fs.rmSync(file, { force: true });
    }
  }
  const globalFile = globalRuntimePath();
  if (!fs.existsSync(globalFile)) return;
  try {
    const runtime = JSON.parse(fs.readFileSync(globalFile, 'utf8'));
    if (!runtime.pid || runtime.pid === pid) fs.rmSync(globalFile, { force: true });
  } catch {
    fs.rmSync(globalFile, { force: true });
  }
}
