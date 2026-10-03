import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('factory audit accepts default option bindings and methods while still rejecting missing dependencies', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-factory-audit-'));
  const file = path.join(directory, 'factory.mjs');
  const source = `export function createSample({ cwd, timeoutMs = 30, onChange = () => {}, spawnProcess = globalThis.spawn } = {}) {
    class Failure { constructor(message, code) { this.message = message; this.code = code; } }
    const { role = 'peer', rpcFactory = (value) => value } = { role: cwd };
    let captured, databases = [], active = false, scopedCtx = { root: cwd };
    const hash = cwd, originalHash = hash;
    const read = [[originalHash, active]].map(([name, readOnly]) => ({ name, readOnly }));
    const proxy = new Proxy(scopedCtx, { get(target, key) { return Reflect.get(target, key); } });
    captured = proxy.root; databases.push(read);
    return { send({ text, turnId } = {}, beforeSubmit = () => {}) { beforeSubmit(); onChange({ text, turnId, role, captured, databases }); return spawnProcess(cwd, timeoutMs, rpcFactory(new Failure(text, turnId))); } };
  }`;
  try {
    fs.writeFileSync(file, source);
    const audit = () => spawnSync(process.execPath, ['scripts/check-free-identifiers.mjs', file], { encoding: 'utf8' });
    const valid = audit(); assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    fs.writeFileSync(file, source.replace('return spawnProcess(', 'return missingExecutor('));
    const invalid = audit(); assert.equal(invalid.status, 1); assert.match(invalid.stderr, /missingExecutor/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
