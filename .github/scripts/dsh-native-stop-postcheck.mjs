import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const completeIdentity = value => Number.isInteger(value?.pid) && value.pid > 0 &&
  typeof value.startToken === 'string' && value.startToken.trim().length > 0 &&
  typeof value.commandHash === 'string' && /^[a-f0-9]{64}$/.test(value.commandHash);
const sameIdentity = (a, b) => completeIdentity(a) && completeIdentity(b) &&
  a.pid === b.pid && a.startToken === b.startToken && a.commandHash === b.commandHash;

export async function confirmNativeStop({ expected, readPointer, readOwner, inspect, compare,
  timeoutMs = 30000, pollMs = 100, onObservation = () => {} }) {
  const deadline = performance.now() + timeoutMs;
  let identity, observation;
  const unverified = () => ({ success: false, code: 'NATIVE_STOP_UNVERIFIED', ...observation });
  while (true) {
    const pointer = readPointer(), owner = readOwner();
    observation = { pointerAbsent: pointer === null, ownerState: owner?.state || 'unknown',
      generation: owner?.generation || null, identity: identity || null, processState: 'unknown' };
    if (!owner || !['live', 'dead', 'released'].includes(owner.state) || owner.generation !== expected.generation ||
        owner.meshDb !== (expected.ownerMeshDb || expected.meshDb) || !completeIdentity(owner.identity) || owner.identity.pid !== expected.pid) return unverified();
    identity ||= { ...owner.identity };
    observation.identity = identity;
    if (!sameIdentity(identity, owner.identity)) return unverified();
    if (pointer !== null && (!pointer || pointer.generation !== expected.generation || pointer.pid !== expected.pid ||
        pointer.root !== expected.root || pointer.meshDb !== expected.meshDb || !sameIdentity(identity, pointer.ownerIdentity))) return unverified();
    const current = inspect(identity.pid);
    if (current?.state === 'dead') observation.processState = 'dead';
    else if (current?.state === 'live' && completeIdentity(current.identity) && current.identity.pid === identity.pid) {
      const comparison = compare(identity, current.identity);
      observation.processState = comparison === 'dead' ? 'reused' : comparison;
    }
    onObservation(observation);
    if (!['dead', 'reused', 'live'].includes(observation.processState)) return unverified();
    if (observation.pointerAbsent && owner.state === 'released' && ['dead', 'reused'].includes(observation.processState)) {
      return { success: true, ...observation };
    }
    if (performance.now() >= deadline) return { success: false, code: 'NATIVE_STOP_TIMEOUT', ...observation };
    await delay(Math.min(pollMs, Math.max(1, deadline - performance.now())));
  }
}

const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function packageHashes(directory) {
  const hashes = {};
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      if (!relative && entry.name === 'node_modules') continue;
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else { assert.ok(entry.isFile(), 'Package entries must be regular files'); hashes[name] = hash(path.join(directory, name)); }
    }
  }
  visit(''); return hashes;
}

function startupResult(file) {
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(Buffer.byteLength(text) <= 65536, 'Native startup receipt must be bounded');
  // The frozen script saves stdout followed by stderr. Parse the first complete
  // JSON response and tolerate only trailing diagnostics, without printing them.
  for (const end of [...text.matchAll(/\n/g)].map(match => match.index).concat(text.length)) {
    try { const value = JSON.parse(text.slice(0, end)); if (value.ok === true && value.data) return value.data; } catch {}
  }
  throw new Error('Native startup receipt has no successful JSON response');
}

function within(directory, target) {
  const relative = path.relative(directory, target);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

function validateInput(options) {
  const receiptBytes = fs.readFileSync(options.receipt), receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.passed, true, 'The original installed CLI acceptance must pass');
  assert.ok(path.isAbsolute(receipt.directory), 'The acceptance directory must be absolute');
  const directory = fs.realpathSync(receipt.directory);
  assert.equal(directory, receipt.directory, 'Acceptance directory must retain its canonical spelling');
  const prefix = path.join(directory, 'npm-install');
  assert.equal(receipt.packageInstallPrefix, prefix, 'Installed prefix must belong to this acceptance fixture');
  assert.equal(fs.realpathSync(prefix), prefix, 'Installed prefix must not redirect');
  const installed = path.join(prefix, 'node_modules', '@logicseek', 'hello-cc');
  assert.equal(fs.realpathSync(installed), installed, 'Installed package must not redirect');
  const home = path.join(directory, 'home'), root = path.join(directory, 'project');
  for (const child of [home, root]) assert.equal(fs.realpathSync(child), child, 'Fixture directories must not redirect');
  assert.equal(receipt.package?.sha256, hash(options.tarball), 'Receipt must match the selected tarball');
  const selected = fs.realpathSync(options.selectedPackage), selectedHashes = packageHashes(selected);
  assert.deepEqual(packageHashes(installed), selectedHashes, 'Installed bytes must match the selected package');
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json')));
  assert.equal(manifest.name, '@logicseek/hello-cc');
  const expected = startupResult(path.join(directory, 'hcc-native-up.log'));
  assert.equal(expected.root, root); assert.ok(typeof expected.meshDb === 'string' && path.isAbsolute(expected.meshDb));
  assert.ok(Number.isInteger(expected.pid) && expected.pid > 0);
  assert.ok(typeof expected.generation === 'string' && expected.generation.length > 0);
  return { directory, home, root, installed, expected,
    originalReceiptSha256: createHash('sha256').update(receiptBytes).digest('hex'),
    originalNativeRuntimeStopped: receipt.cleanup?.nativeRuntimeStopped ?? null,
    packageSha256: receipt.package.sha256, verifiedPackageFiles: Object.keys(selectedHashes).length };
}

async function observeInstalled(data) {
  assert.equal(os.homedir(), data.home, 'The native profile lookup must select the acceptance home');
  const store = await import(pathToFileURL(path.join(data.installed, 'lib/runtime/native/store.mjs')));
  const processIdentity = await import(pathToFileURL(path.join(data.installed, 'lib/process/identity.mjs')));
  const { resolveProjectDatabase } = await import(pathToFileURL(path.join(data.installed, 'lib/runtime/project-path.mjs')));
  const { projectStateDir } = await import(pathToFileURL(path.join(data.installed, 'lib/runtime/paths.mjs')));
  const { inspectPrivateProjectAuthority } = await import(pathToFileURL(path.join(data.installed, 'lib/runtime/private-state.mjs')));
  if (projectStateDir(data.root) !== path.join(data.root, '.hello-cc')) {
    assert.ok(['fresh', 'migrated'].includes(inspectPrivateProjectAuthority(data.root)),
      'Postconfirmation cannot finish or repair a pending private-state binding');
  }
  const selected = resolveProjectDatabase({ root: data.root, db: data.expected.meshDb, createStateDir: false });
  const original = resolveProjectDatabase({ root: data.root, db: path.join(data.root, '.hello-cc', 'mesh.db'), createStateDir: false });
  assert.equal(selected.db, original.db, 'Startup must select the same project database as the original acceptance CLI');
  const ownedState = file => within(data.home, file) || within(path.join(data.root, '.hello-cc'), file);
  assert.ok(ownedState(selected.db), 'Selected database must belong to this fixture profile or project state');
  assert.equal(fs.realpathSync(selected.db), selected.db, 'Selected database must not redirect');
  const ctx = { root: data.root, dbPath: data.expected.meshDb };
  const inspectDatabase = () => {
    const paths = store.nativePaths(ctx);
    assert.ok(paths && ownedState(paths.db), 'Native owner database must belong to this fixture profile or project state');
    assert.equal(paths.meshDb, selected.db, 'Native state must select the original project database');
    assert.equal(fs.realpathSync(paths.db), paths.db, 'Native owner database must not redirect');
    const stat = fs.lstatSync(paths.db);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Native owner database must already exist as one regular file');
    if (process.platform !== 'win32') assert.ok(stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600,
      'Postconfirmation cannot repair native database ownership or permissions');
    return { file: paths.db, dev: stat.dev, ino: stat.ino };
  };
  return confirmNativeStop({ expected: { ...data.expected, ownerMeshDb: selected.db }, timeoutMs: data.timeoutMs,
    readPointer: () => store.readNativePointer(ctx),
    readOwner: () => {
      const before = inspectDatabase(), owner = store.readNativeOwnerStatus(ctx), after = inspectDatabase();
      assert.deepEqual(after, before, 'Native owner database changed during observation');
      return owner;
    },
    inspect: processIdentity.inspectProcessIdentity, compare: processIdentity.compareProcessIdentity,
    onObservation: value => parentPort.postMessage({ observation: value }) });
}

async function main() {
  const options = { timeoutMs: 30000 }, args = process.argv.slice(2);
  while (args.length) {
    const key = args.shift(), value = args.shift();
    const names = { '--receipt': 'receipt', '--selected-package': 'selectedPackage', '--tarball': 'tarball', '--output': 'output', '--timeout-ms': 'timeoutMs' };
    if (!names[key] || !value) throw new Error('Expected --receipt FILE --selected-package DIR --tarball FILE --output FILE');
    options[names[key]] = key === '--timeout-ms' ? Number(value) : path.resolve(value);
  }
  assert.ok(options.output && options.receipt && options.selectedPackage && options.tarball);
  assert.ok(Number.isInteger(options.timeoutMs) && options.timeoutMs >= 100 && options.timeoutMs <= 60000);
  assert.notEqual(options.output, options.receipt, 'The original receipt must never be overwritten');
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), success: false,
    scope: 'Read-only CI postconfirmation of the original installed native runtime; no process signals or model calls' };
  const save = () => {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  };
  try {
    const data = validateInput(options);
    Object.assign(report, { originalReceiptSha256: data.originalReceiptSha256,
      originalNativeRuntimeStopped: data.originalNativeRuntimeStopped, packageSha256: data.packageSha256,
      verifiedPackageFiles: data.verifiedPackageFiles, expectedGeneration: data.expected.generation, expectedPid: data.expected.pid });
    save();
    const env = { PATH: process.env.PATH || '', HOME: data.home, USERPROFILE: data.home, TMPDIR: data.directory,
      HCC_SKIP_SHIM_INSTALL: '1', NODE_NO_WARNINGS: '1' };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    // Worker.env isolates JS environment variables, but native os.homedir()
    // uses its process-wide profile. Change only this dedicated verifier CLI's
    // environment before the worker imports installed state readers.
    process.env.HOME = data.home; process.env.USERPROFILE = data.home;
    const worker = new Worker(new URL(import.meta.url), { workerData: { ...data, timeoutMs: options.timeoutMs }, env });
    await new Promise(resolve => {
      let finished = false;
      const finish = value => {
        if (finished) return;
        finished = true; clearTimeout(timer); Object.assign(report, value);
        worker.unref(); void worker.terminate(); resolve();
      };
      const timer = setTimeout(() => finish({ success: false, code: 'NATIVE_STOP_TIMEOUT' }), options.timeoutMs);
      worker.on('message', value => {
        if (finished) return;
        if (value.observation) { Object.assign(report, value.observation); save(); }
        else finish(value);
      });
      worker.on('error', () => finish({ success: false, code: 'NATIVE_STOP_UNVERIFIED' }));
      worker.on('exit', code => { if (!finished) finish({ success: false, code: 'NATIVE_STOP_UNVERIFIED', verifierExitCode: code }); });
    });
  } catch { report.success = false; report.code = 'NATIVE_STOP_UNVERIFIED'; }
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify(report));
  process.exitCode = report.success ? 0 : 1;
}

if (!isMainThread) {
  observeInstalled(workerData).then(value => parentPort.postMessage(value), () => parentPort.postMessage({ success: false, code: 'NATIVE_STOP_UNVERIFIED' }));
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Native stop postconfirmation arguments are invalid'); process.exitCode = 1; });
}
