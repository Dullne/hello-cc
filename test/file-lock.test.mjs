import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withFileLock } from '../lib/shared/file-lock.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const projectsModuleUrl = pathToFileURL(path.join(repoRoot, 'lib/runtime/projects.mjs')).href;
const lockModuleUrl = pathToFileURL(path.join(repoRoot, 'lib/shared/file-lock.mjs')).href;
const NONBLOCKING_LOCK_DEADLINE_MS = 2_500;

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-file-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function waitForPath(file, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited ${code ?? signal}: ${stderr}`));
    });
  });
}

async function waitForAnyPath(files, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!files.some((file) => fs.existsSync(file))) {
    if (performance.now() >= deadline) throw new Error('timed out waiting for child barrier');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('concurrent project registry writers retain both roots', async (t) => {
  const root = sandbox(t);
  const home = path.join(root, 'home');
  const registryDir = path.join(home, '.hello-cc');
  const registryPath = path.join(registryDir, 'projects.json');
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  const readyA = path.join(root, 'ready-a');
  const readyB = path.join(root, 'ready-b');
  const release = path.join(root, 'release');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify({ projects: [] }));

  const childSource = String.raw`
    import fs from 'node:fs';
    const [moduleUrl, projectRoot, readyPath, releasePath] = process.argv.slice(1);
    const registrySuffix = '/.hello-cc/projects.json';
    const originalRead = fs.readFileSync.bind(fs);
    let paused = false;
    fs.readFileSync = function(file, ...args) {
      const value = originalRead(file, ...args);
      if (!paused && String(file).endsWith(registrySuffix)) {
        paused = true;
        fs.writeFileSync(readyPath, 'ready');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(releasePath)) Atomics.wait(wait, 0, 0, 10);
      }
      return value;
    };
    const { registerProject } = await import(moduleUrl);
    registerProject({ root: projectRoot, dbPath: projectRoot + '/mesh.db' });
  `;
  const childOptions = {
    cwd: repoRoot,
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'ignore', 'pipe']
  };
  const childA = spawn(process.execPath, ['--input-type=module', '-e', childSource,
    projectsModuleUrl, projectA, readyA, release], childOptions);
  const childB = spawn(process.execPath, ['--input-type=module', '-e', childSource,
    projectsModuleUrl, projectB, readyB, release], childOptions);
  t.after(() => {
    for (const child of [childA, childB]) {
      try { child.kill('SIGKILL'); } catch {}
    }
  });

  await waitForAnyPath([readyA, readyB]);
  fs.writeFileSync(release, 'go');
  await Promise.all([waitForExit(childA), waitForExit(childB)]);

  const projects = JSON.parse(fs.readFileSync(registryPath, 'utf8')).projects;
  assert.deepEqual(
    new Set(projects.map((project) => project.root)),
    new Set([fs.realpathSync.native(projectA), fs.realpathSync.native(projectB)])
  );
});

test('registry writers stay in their acquired canonical domain when HOME is retargeted', async (t) => {
  const root = sandbox(t);
  const homeA = path.join(root, 'home-a');
  const homeB = path.join(root, 'home-b');
  const homeAlias = path.join(root, 'home-alias');
  const registryA = path.join(homeA, '.hello-cc', 'projects.json');
  const registryB = path.join(homeB, '.hello-cc', 'projects.json');
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  const ready = path.join(root, 'old-writer-ready');
  const release = path.join(root, 'release-old-writer');
  for (const directory of [path.dirname(registryA), path.dirname(registryB), projectA, projectB]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(registryA, JSON.stringify({ projects: [] }));
  fs.writeFileSync(registryB, JSON.stringify({ projects: [] }));
  fs.symlinkSync(homeA, homeAlias, 'dir');

  const pausedWriterSource = String.raw`
    import fs from 'node:fs';
    const [moduleUrl, projectRoot, readyPath, releasePath] = process.argv.slice(1);
    const originalRead = fs.readFileSync.bind(fs);
    let paused = false;
    fs.readFileSync = function(file, ...args) {
      const value = originalRead(file, ...args);
      if (!paused && String(file).endsWith('/.hello-cc/projects.json')) {
        paused = true;
        fs.writeFileSync(readyPath, 'ready');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(releasePath)) Atomics.wait(wait, 0, 0, 10);
      }
      return value;
    };
    const { registerProject } = await import(moduleUrl);
    registerProject({ root: projectRoot, dbPath: projectRoot + '/mesh.db' });
  `;
  const writerSource = String.raw`
    const [moduleUrl, projectRoot] = process.argv.slice(1);
    const { registerProject } = await import(moduleUrl);
    registerProject({ root: projectRoot, dbPath: projectRoot + '/mesh.db' });
  `;
  const oldWriter = spawn(process.execPath, ['--input-type=module', '-e', pausedWriterSource,
    projectsModuleUrl, projectA, ready, release], {
    cwd: repoRoot,
    env: { ...process.env, HOME: homeAlias },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  t.after(() => {
    try { oldWriter.kill('SIGKILL'); } catch {}
  });

  await waitForPath(ready);
  fs.unlinkSync(homeAlias);
  fs.symlinkSync(homeB, homeAlias, 'dir');
  const newWriter = spawn(process.execPath, ['--input-type=module', '-e', writerSource,
    projectsModuleUrl, projectB], {
    cwd: repoRoot,
    env: { ...process.env, HOME: homeB },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  t.after(() => {
    try { newWriter.kill('SIGKILL'); } catch {}
  });
  await waitForExit(newWriter);
  fs.writeFileSync(release, 'go');
  await waitForExit(oldWriter);

  const rootsA = JSON.parse(fs.readFileSync(registryA, 'utf8')).projects.map((row) => row.root);
  const rootsB = JSON.parse(fs.readFileSync(registryB, 'utf8')).projects.map((row) => row.root);
  assert.deepEqual(rootsA, [fs.realpathSync.native(projectA)]);
  assert.deepEqual(rootsB, [fs.realpathSync.native(projectB)]);
});

test('registry update callback uses only its locked canonical path', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'lib/runtime/projects.mjs'), 'utf8');
  const start = source.indexOf('function updateProjectRegistry(');
  const end = source.indexOf('\nexport function registerProject(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const updateSource = source.slice(start, end);
  const callbackSource = updateSource.slice(updateSource.indexOf('withFileLock('));
  assert.doesNotMatch(callbackSource, /projectRegistryPath\s*\(/);
  assert.doesNotMatch(callbackSource, /readProjectRegistry\s*\(\s*\)/);
  assert.match(callbackSource, /readProjectRegistryFrom\s*\(\s*lockedRegistryPath\s*\)/);
  assert.match(callbackSource, /persistProjectRegistry\s*\(\s*lockedRegistryPath\s*,/);
});

test('same root with a different resolved DB updates inside the throttle window', async (t) => {
  const root = sandbox(t);
  const home = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  const { registerProject } = await import(`${projectsModuleUrl}?db-update=${Date.now()}`);

  const first = registerProject({ root: projectRoot, dbPath: path.join(projectRoot, 'one.db') });
  const second = registerProject({
    root: path.join(projectRoot, '.'),
    dbPath: path.join(projectRoot, 'nested', '..', 'two.db')
  });

  const canonicalRoot = fs.realpathSync.native(projectRoot);
  assert.equal(first[0].db, path.join(canonicalRoot, 'one.db'));
  assert.equal(second[0].db, path.join(canonicalRoot, 'two.db'));
});

test('future registry timestamps and process clock rollback are refreshed immediately', async (t) => {
  const root = sandbox(t);
  const home = path.join(root, 'home');
  const registryDir = path.join(home, '.hello-cc');
  const registryPath = path.join(registryDir, 'projects.json');
  const projectRoot = path.join(root, 'project');
  const dbPath = path.join(projectRoot, 'mesh.db');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(registryDir, { recursive: true });
  const canonicalRoot = fs.realpathSync.native(projectRoot);
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  let wallMs = Math.floor(Date.now() / 1000) * 1000 + 500;
  t.mock.method(Date, 'now', () => wallMs);
  const futureTimestamp = Math.floor(wallMs / 1000) + 3600;
  const writeFuture = () => fs.writeFileSync(registryPath, JSON.stringify({
    projects: [{
      root: canonicalRoot,
      db: dbPath,
      name: 'project',
      last_seen_at: futureTimestamp
    }]
  }));
  const moduleUrl = `${projectsModuleUrl}?future-clock=${wallMs}`;
  const { registerProject, registerProjectActivity } = await import(moduleUrl);

  writeFuture();
  const registered = registerProject({ root: projectRoot, dbPath });
  assert.equal(registered[0].last_seen_at, Math.floor(wallMs / 1000));

  writeFuture();
  registerProjectActivity({ root: projectRoot, dbPath });
  let persisted = JSON.parse(fs.readFileSync(registryPath, 'utf8')).projects[0];
  assert.equal(persisted.last_seen_at, Math.floor(wallMs / 1000));

  writeFuture();
  wallMs -= 1;
  registerProjectActivity({ root: projectRoot, dbPath });
  persisted = JSON.parse(fs.readFileSync(registryPath, 'utf8')).projects[0];
  assert.equal(persisted.last_seen_at, Math.floor(wallMs / 1000));
});

test('project activity is nonblocking and retries soon after a busy first write', async (t) => {
  const root = sandbox(t);
  const home = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  const registryDir = path.join(home, '.hello-cc');
  const registryPath = path.join(registryDir, 'projects.json');
  const ready = path.join(root, 'holder-ready');
  const release = path.join(root, 'holder-release');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify({ projects: [] }));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  const { registerProject, registerProjectActivity } = await import(`${projectsModuleUrl}?activity-busy=${Date.now()}`);
  const holderSource = String.raw`
    import fs from 'node:fs';
    const [moduleUrl, target, ready, release] = process.argv.slice(1);
    const { withFileLock } = await import(moduleUrl);
    withFileLock(target, () => {
      fs.writeFileSync(ready, 'ready');
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 10);
    });
  `;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderSource,
    lockModuleUrl, registryPath, ready, release], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  t.after(() => {
    try { holder.kill('SIGKILL'); } catch {}
  });
  await waitForPath(ready);
  const registerStarted = performance.now();
  assert.throws(
    () => registerProject({ root: projectRoot, dbPath: path.join(projectRoot, 'one.db') }, { nonblocking: true }),
    (error) => error?.code === 'ERR_FILE_LOCK_BUSY'
  );
  const registerElapsed = performance.now() - registerStarted;
  assert.ok(registerElapsed < NONBLOCKING_LOCK_DEADLINE_MS,
    `nonblocking register waited ${registerElapsed}ms`);
  const started = performance.now();

  registerProjectActivity({ root: projectRoot, dbPath: path.join(projectRoot, 'one.db') });
  const activityElapsed = performance.now() - started;
  assert.ok(activityElapsed < NONBLOCKING_LOCK_DEADLINE_MS,
    `nonblocking activity update waited ${activityElapsed}ms`);
  assert.deepEqual(JSON.parse(fs.readFileSync(registryPath, 'utf8')).projects, []);

  fs.writeFileSync(release, 'go');
  await waitForExit(holder);
  await new Promise((resolve) => setTimeout(resolve, 300));
  registerProjectActivity({ root: projectRoot, dbPath: path.join(projectRoot, 'one.db') });
  const projects = JSON.parse(fs.readFileSync(registryPath, 'utf8')).projects;
  assert.equal(projects.length, 1);
  assert.equal(projects[0].root, fs.realpathSync.native(projectRoot));
});

test('project activity throttles repeated root and DB writes but tries a DB change immediately', async (t) => {
  const root = sandbox(t);
  const home = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  const projectAlias = path.join(root, 'project-alias');
  fs.mkdirSync(projectRoot);
  fs.symlinkSync(projectRoot, projectAlias, 'dir');
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  const { registerProjectActivity } = await import(`${projectsModuleUrl}?activity-cache=${Date.now()}`);
  const registryPath = path.join(home, '.hello-cc', 'projects.json');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const canonicalRegistryPath = path.join(
    fs.realpathSync.native(path.dirname(registryPath)),
    path.basename(registryPath)
  );
  const originalRename = fs.renameSync.bind(fs);
  let registryWrites = 0;
  t.mock.method(fs, 'renameSync', (source, destination, ...args) => {
    if (path.resolve(destination) === canonicalRegistryPath) registryWrites += 1;
    return originalRename(source, destination, ...args);
  });

  registerProjectActivity({ root: projectAlias, dbPath: path.join(projectAlias, 'one.db') });
  registerProjectActivity({ root: projectRoot, dbPath: path.join(projectRoot, 'one.db') });
  registerProjectActivity({ root: projectAlias, dbPath: path.join(projectAlias, 'two.db') });
  registerProjectActivity({ root: projectRoot, dbPath: path.join(projectRoot, 'one.db') });

  // The duplicate is throttled, while both DB binding changes are persisted.
  assert.equal(registryWrites, 3);
  const projects = JSON.parse(fs.readFileSync(registryPath, 'utf8')).projects;
  assert.equal(projects.length, 1);
  assert.equal(projects[0].db, path.join(fs.realpathSync.native(projectRoot), 'one.db'));
});

test('real root and symlink alias share one canonical record and DB changes bypass throttling', async (t) => {
  const root = sandbox(t);
  const home = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  const projectAlias = path.join(root, 'project-alias');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.symlinkSync(projectRoot, projectAlias, 'dir');
  const canonicalRoot = fs.realpathSync.native(projectRoot);
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  const moduleUrl = `${projectsModuleUrl}?canonical-register=${Date.now()}`;
  const { projectRecord, readProjectRegistry, registerProject } = await import(moduleUrl);

  const publicRecord = projectRecord({ root: projectAlias, dbPath: path.join(projectAlias, 'current.db') });
  registerProject({ root: projectRoot, dbPath: path.join(projectRoot, 'one.db') });
  const rebound = registerProject({ root: projectAlias, dbPath: path.join(projectAlias, 'two.db') });
  const readBack = readProjectRegistry();

  assert.equal(publicRecord.root, canonicalRoot);
  assert.equal(publicRecord.db, path.join(canonicalRoot, 'current.db'));
  assert.equal(rebound.length, 1);
  assert.equal(rebound[0].root, canonicalRoot);
  assert.equal(rebound[0].db, path.join(canonicalRoot, 'two.db'));
  assert.equal(readBack.length, 1);
  assert.equal(readBack[0].root, canonicalRoot);
  assert.equal(readBack[0].db, path.join(canonicalRoot, 'two.db'));
});

test('read canonicalizes and deduplicates stored real-root and symlink-alias records', async (t) => {
  const root = sandbox(t);
  const home = path.join(root, 'home');
  const registryDir = path.join(home, '.hello-cc');
  const projectRoot = path.join(root, 'project');
  const projectAlias = path.join(root, 'project-alias');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.symlinkSync(projectRoot, projectAlias, 'dir');
  fs.writeFileSync(path.join(registryDir, 'projects.json'), JSON.stringify({
    projects: [
      {
        root: projectRoot,
        db: path.join(projectRoot, 'old.db'),
        name: 'real',
        last_seen_at: 1
      },
      {
        root: projectAlias,
        db: path.join(projectAlias, 'mesh.db'),
        name: 'alias',
        last_seen_at: 2
      }
    ]
  }));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  const { readProjectRegistry } = await import(`${projectsModuleUrl}?canonical-read=${Date.now()}`);

  const projects = readProjectRegistry();

  assert.equal(projects.length, 1);
  assert.equal(projects[0].root, fs.realpathSync.native(projectRoot));
  assert.equal(projects[0].db, path.join(fs.realpathSync.native(projectRoot), 'mesh.db'));
  assert.equal(projects[0].name, 'alias');
});

test('canonical dedupe keeps the newest valid record independent of input order', async (t) => {
  const root = sandbox(t);
  const home = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  const aliasA = path.join(root, 'alias-a');
  const aliasB = path.join(root, 'alias-b');
  fs.mkdirSync(projectRoot);
  fs.symlinkSync(projectRoot, aliasA, 'dir');
  fs.symlinkSync(projectRoot, aliasB, 'dir');
  const canonicalRoot = fs.realpathSync.native(projectRoot);
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  const { writeProjectRegistry } = await import(`${projectsModuleUrl}?newest-dedupe=${Date.now()}`);
  const newer = { root: aliasA, db: path.join(aliasA, 'new.db'), name: 'new', last_seen_at: 200 };
  const older = { root: projectRoot, db: path.join(projectRoot, 'old.db'), name: 'old', last_seen_at: 100 };
  const invalid = { root: aliasB, db: path.join(aliasB, 'invalid.db'), name: 'invalid', last_seen_at: 'bad' };

  const descending = writeProjectRegistry([newer, older, invalid]);
  const reversed = writeProjectRegistry([invalid, older, newer]);

  for (const rows of [descending, reversed]) {
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      root: canonicalRoot,
      db: path.join(canonicalRoot, 'new.db'),
      name: 'new',
      last_seen_at: 200
    });
  }
});

test('canonical dedupe has an order-independent deterministic tie break', async (t) => {
  const root = sandbox(t);
  const home = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  const aliasA = path.join(root, 'alias-a');
  const aliasB = path.join(root, 'alias-b');
  fs.mkdirSync(projectRoot);
  fs.symlinkSync(projectRoot, aliasA, 'dir');
  fs.symlinkSync(projectRoot, aliasB, 'dir');
  const canonicalRoot = fs.realpathSync.native(projectRoot);
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  const { writeProjectRegistry } = await import(`${projectsModuleUrl}?tie-dedupe=${Date.now()}`);
  const canonical = {
    root: canonicalRoot,
    db: path.join(canonicalRoot, 'z.db'),
    name: 'canonical',
    last_seen_at: 300
  };
  const aliasLexicalFirst = {
    root: aliasA,
    db: path.join(aliasA, 'a.db'),
    name: 'alias-a',
    last_seen_at: 300
  };
  const aliasLexicalLast = {
    root: aliasB,
    db: path.join(aliasB, 'b.db'),
    name: 'alias-b',
    last_seen_at: 300
  };

  const forward = writeProjectRegistry([aliasLexicalFirst, canonical, aliasLexicalLast]);
  const reverse = writeProjectRegistry([aliasLexicalLast, canonical, aliasLexicalFirst]);

  assert.deepEqual(forward, reverse);
  assert.equal(forward.length, 1);
  assert.equal(forward[0].name, 'canonical');
  assert.equal(forward[0].db, path.join(canonicalRoot, 'z.db'));
});

test('new alias DB record is not overwritten or refreshed from an older real-root record', async (t) => {
  const root = sandbox(t);
  const home = path.join(root, 'home');
  const registryDir = path.join(home, '.hello-cc');
  const projectRoot = path.join(root, 'project');
  const projectAlias = path.join(root, 'project-alias');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.mkdirSync(projectRoot);
  fs.symlinkSync(projectRoot, projectAlias, 'dir');
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(registryDir, 'projects.json'), JSON.stringify({
    projects: [
      {
        root: projectAlias,
        db: path.join(projectAlias, 'new.db'),
        name: 'new-alias-record',
        last_seen_at: now
      },
      {
        root: projectRoot,
        db: path.join(projectRoot, 'old.db'),
        name: 'old-real-record',
        last_seen_at: now - 10
      }
    ]
  }));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  const { readProjectRegistry, registerProject } = await import(`${projectsModuleUrl}?new-alias=${Date.now()}`);

  const registered = registerProject({ root: projectAlias, dbPath: path.join(projectAlias, 'new.db') });
  const readBack = readProjectRegistry();

  for (const rows of [registered, readBack]) {
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'new-alias-record');
    assert.equal(rows[0].last_seen_at, now);
    assert.equal(rows[0].db, path.join(fs.realpathSync.native(projectRoot), 'new.db'));
  }
});

test('drops a stored DB alias retargeted outside its canonical project root', async (t) => {
  const root = sandbox(t);
  const home = path.join(root, 'home');
  const registryDir = path.join(home, '.hello-cc');
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  const alias = path.join(root, 'project-alias');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.mkdirSync(projectA);
  fs.mkdirSync(projectB);
  fs.symlinkSync(projectA, alias, 'dir');
  const canonicalA = fs.realpathSync.native(projectA);
  fs.writeFileSync(path.join(registryDir, 'projects.json'), JSON.stringify({
    projects: [{
      root: canonicalA,
      db: path.join(alias, 'mesh.db'),
      name: 'retargeted',
      last_seen_at: 1
    }]
  }));
  fs.unlinkSync(alias);
  fs.symlinkSync(projectB, alias, 'dir');
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  const { readProjectRegistry } = await import(`${projectsModuleUrl}?db-retarget=${Date.now()}`);

  assert.deepEqual(readProjectRegistry(), []);
});

test('concurrent real-root and symlink-alias registration leaves one canonical record', async (t) => {
  const root = sandbox(t);
  const home = path.join(root, 'home');
  const registryDir = path.join(home, '.hello-cc');
  const registryPath = path.join(registryDir, 'projects.json');
  const projectRoot = path.join(root, 'project');
  const projectAlias = path.join(root, 'project-alias');
  const readyReal = path.join(root, 'ready-real');
  const readyAlias = path.join(root, 'ready-alias');
  const release = path.join(root, 'release-alias');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.symlinkSync(projectRoot, projectAlias, 'dir');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: [] }));

  const childSource = String.raw`
    import fs from 'node:fs';
    const [moduleUrl, projectRoot, readyPath, releasePath] = process.argv.slice(1);
    fs.writeFileSync(readyPath, 'ready');
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(releasePath)) Atomics.wait(wait, 0, 0, 10);
    const { registerProject } = await import(moduleUrl);
    registerProject({ root: projectRoot, dbPath: projectRoot + '/mesh.db' });
  `;
  const childOptions = {
    cwd: repoRoot,
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'ignore', 'pipe']
  };
  const realChild = spawn(process.execPath, ['--input-type=module', '-e', childSource,
    projectsModuleUrl, projectRoot, readyReal, release], childOptions);
  const aliasChild = spawn(process.execPath, ['--input-type=module', '-e', childSource,
    projectsModuleUrl, projectAlias, readyAlias, release], childOptions);

  await Promise.all([readyReal, readyAlias].map((file) => waitForPath(file)));
  fs.writeFileSync(release, 'go');
  await Promise.all([waitForExit(realChild), waitForExit(aliasChild)]);

  const projects = JSON.parse(fs.readFileSync(registryPath, 'utf8')).projects;
  assert.equal(projects.length, 1);
  assert.equal(projects[0].root, fs.realpathSync.native(projectRoot));
});

test('rejects an incoming root that resolves to a non-directory', async (t) => {
  const root = sandbox(t);
  const home = path.join(root, 'home');
  const file = path.join(root, 'not-a-project');
  const alias = path.join(root, 'project-alias');
  fs.writeFileSync(file, 'not a directory');
  fs.symlinkSync(file, alias);
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  const { registerProject } = await import(`${projectsModuleUrl}?non-directory=${Date.now()}`);

  assert.throws(
    () => registerProject({ root: alias, dbPath: path.join(alias, 'mesh.db') }),
    /project root.*directory/i
  );
});

test('rejects a root whose filesystem identity changes during canonicalization', async (t) => {
  const root = sandbox(t);
  const home = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  const projectAlias = path.join(root, 'project-alias');
  fs.mkdirSync(projectRoot);
  fs.symlinkSync(projectRoot, projectAlias, 'dir');
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  const { registerProject } = await import(`${projectsModuleUrl}?root-drift=${Date.now()}`);
  const originalStat = fs.statSync.bind(fs);
  let aliasStats = 0;
  t.mock.method(fs, 'statSync', (value, ...args) => {
    const result = originalStat(value, ...args);
    if (path.resolve(String(value)) !== path.resolve(projectAlias) || ++aliasStats === 1) return result;
    const drifted = Object.create(Object.getPrototypeOf(result));
    Object.assign(drifted, result);
    Object.defineProperty(drifted, 'ino', { value: Number(result.ino) + 1 });
    return drifted;
  });

  assert.throws(
    () => registerProject({ root: projectAlias, dbPath: path.join(projectAlias, 'mesh.db') }),
    /project root changed during canonicalization/i
  );
});

test('keeps distinct lexical fallbacks for missing legacy roots', async (t) => {
  const root = sandbox(t);
  const home = path.join(root, 'home');
  const missingA = path.join(root, 'missing', 'a');
  const missingB = path.join(root, 'missing', 'b');
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  const { writeProjectRegistry } = await import(`${projectsModuleUrl}?missing-roots=${Date.now()}`);

  const rows = writeProjectRegistry([
    { root: missingA, db: path.join(missingA, 'mesh.db') },
    { root: missingB, db: path.join(missingB, 'mesh.db') }
  ]);

  assert.deepEqual(new Set(rows.map((row) => row.root)), new Set([missingA, missingB]));
});
