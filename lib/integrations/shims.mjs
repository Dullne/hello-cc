import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { generateShim } from './shims/script.mjs';

export const SHIM_DIR = path.join(os.homedir(), '.hcc-shims');

/**
 * Install shim scripts for `claude` and `codex` into SHIM_DIR.
 * Returns { shimDir, installed: [paths], changed: [paths], skipped: [names] }.
 */
export function installShims(hccBin, opts = {}) {
  fs.mkdirSync(SHIM_DIR, { recursive: true });
  const realBins = opts.realBins && typeof opts.realBins === 'object' ? opts.realBins : {};

  const tools = [
    { name: 'claude', kind: 'claude', resumeFlag: '--resume' },
    { name: 'codex',  kind: 'codex',  resumeSubcmd: 'resume' },
  ];

  const installed = [];
  const changed = [];
  const skipped = [];

  for (const tool of tools) {
    const shimPath = path.join(SHIM_DIR, tool.name);
    let previous = null;
    try { previous = fs.readFileSync(shimPath, 'utf8'); } catch {}
    const requestedRealBin = realBins[tool.name] || null;
    const existingRealBin = previous ? shimRealBinFromContent(previous) : null;
    const realBin = existingRealBin && fsExists(existingRealBin)
      ? existingRealBin
      : requestedRealBin && fsExists(requestedRealBin)
        ? requestedRealBin
        : findRealBinary(tool.name);
    if (!realBin) {
      skipped.push(`${tool.name} (not found on PATH)`);
      continue;
    }
    const content = generateShim(hccBin, realBin, tool);
    if (previous !== content) {
      writeExecutableAtomic(shimPath, content);
      changed.push(shimPath);
    } else {
      try { fs.chmodSync(shimPath, 0o755); } catch {}
    }
    installed.push(shimPath);
  }

  return { shimDir: SHIM_DIR, installed, changed, skipped };
}

/**
 * Remove shim scripts.
 */
export function uninstallShims() {
  const removed = [];
  for (const name of ['claude', 'codex']) {
    const p = path.join(SHIM_DIR, name);
    try { fs.unlinkSync(p); removed.push(p); } catch {}
  }
  try { fs.rmdirSync(SHIM_DIR); } catch {}
  return removed;
}

/**
 * Returns true if at least one shim is installed and in an HCC shim dir.
 */
export function verifyShims() {
  return ['claude', 'codex'].some(name =>
    fsExists(path.join(SHIM_DIR, name))
  );
}

export function shimStatus() {
  const tools = {};
  for (const name of ['claude', 'codex']) {
    const shimPath = path.join(SHIM_DIR, name);
    tools[name] = { installed: fsExists(shimPath), path: shimPath };
  }
  return {
    shimDir: SHIM_DIR,
    tools,
    installed: Object.values(tools).some((tool) => tool.installed),
    complete: Object.values(tools).every((tool) => tool.installed)
  };
}

/**
 * Find the real binary for `name`, skipping the SHIM_DIR.
 * Checks PATH, then npm global bin, then common install locations.
 */
export function findRealBinary(name) {
  // which -a lists all matches; pick first one outside SHIM_DIR
  const r = spawnSync('which', ['-a', name], { encoding: 'utf8', timeout: 3000 });
  if (r.status === 0) {
    for (const p of r.stdout.trim().split('\n')) {
      const resolved = p.trim();
      if (resolved && !resolved.startsWith(SHIM_DIR)) return resolved;
    }
  }

  // Try npm global bin
  const npmR = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 3000 });
  if (npmR.status === 0) {
    const npmBin = path.join(path.dirname(npmR.stdout.trim()), 'bin', name);
    if (fsExists(npmBin)) return npmBin;
  }

  // Common locations
  for (const dir of [
    '/usr/local/bin',
    '/usr/bin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.nvm', 'current', 'bin'),
  ]) {
    const p = path.join(dir, name);
    if (fsExists(p)) return p;
  }

  return null;
}

function fsExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function shimRealBinFromContent(content) {
  const match = String(content || '').match(/^# Real binary: ([^\r\n]+)$/m);
  return match ? match[1] : null;
}

function writeExecutableAtomic(file, content) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { mode: 0o755 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}
