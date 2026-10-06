import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(new URL('../lib/runtime/private-state.mjs', import.meta.url));
const migrationModulePath = fileURLToPath(new URL('../lib/runtime/state-migration.mjs', import.meta.url));
const cliPath = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
const childCode = `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const api = await import(pathToFileURL(process.env.HCC_PRIVATE_STATE_MODULE).href);
const migration = await import(pathToFileURL(process.env.HCC_STATE_MIGRATION_MODULE).href);
const { action, root, options } = JSON.parse(fs.readFileSync(0, 'utf8'));
try {
  if (action === 'invalid-birthtime') {
    const stat = fs.statSync;
    const canonicalRoot = fs.realpathSync(root);
    fs.statSync = (target, statOptions) => {
      const current = stat(target, statOptions);
      if (target === canonicalRoot && statOptions?.bigint) {
        current.birthtimeNs = options.birthtimeKind === 'negative' ? -1n
          : options.birthtimeKind === 'missing' ? undefined
          : options.birthtimeKind === 'string' ? '123' : 0n;
      }
      return current;
    };
  }
  if (action === 'fail-authority-publish' || action === 'fail-manifest-publish' ||
      action === 'fail-generation-publish' || action === 'fail-upgrade-manifest') {
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if ((action === 'fail-authority-publish' && target.endsWith('.authority.json')) ||
          (action === 'fail-manifest-publish' && target.endsWith('/.project-root.json'))) {
        throw Object.assign(new Error('injected failure'), { code: 'EIO' });
      }
      if (action === 'fail-generation-publish' && target.includes('.generations/') &&
          target.endsWith('.authority.json')) {
        throw Object.assign(new Error('injected failure'), { code: 'EIO' });
      }
      if (action === 'fail-upgrade-manifest' && target.endsWith('/.project-root.json')) {
        throw Object.assign(new Error('injected failure'), { code: 'EIO' });
      }
      return rename(source, target);
    };
  }
  const value = action === 'path' ? api.privateProjectStateDir(root)
    : action === 'base' ? api.privateStateBaseDir()
    : action === 'global' ? api.validatedGlobalStateDir()
    : action === 'authority' ? api.privateProjectAuthorityPath(root)
    : action === 'inspect-upgrade' ? api.inspectPrivateProjectBindingUpgrade(root)
    : action === 'upgrade' || action === 'fail-upgrade-manifest' ||
      action === 'fail-upgrade-after-check'
      ? api.upgradePrivateProjectBinding(root, { ...options,
          assertOffline: ({ phase, stateDir }) => {
            migration.assertPrivateStateOffline(stateDir);
            return action !== 'fail-upgrade-after-check' || phase !== 'after';
          } })
    : action === 'provision' || action === 'fail-generation-publish'
      ? api.provisionPrivateProjectGeneration(root)
    : action === 'purge' ? api.purgePrivateProjectState(root)
    : api.ensurePrivateProjectStateDir(root, options);
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
}
`;

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hcc-private-store-'));
  const home = path.join(sandbox, 'home');
  const root = path.join(sandbox, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(root, { mode: 0o755 });
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  return { sandbox, home, root };
}

function invoke(f, action, root = f.root, options = undefined) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    input: JSON.stringify({ action, root, options }),
    env: { ...process.env, HOME: f.home, HCC_PRIVATE_STATE_MODULE: modulePath,
      HCC_STATE_MIGRATION_MODULE: migrationModulePath },
    encoding: 'utf8',
    timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

function invokeCli(f, args, command = 'migrate-state') {
  const result = spawnSync(process.execPath,
    [cliPath, '--root', f.root, '--json', command, ...args], {
      env: { ...process.env, HOME: f.home, NODE_NO_WARNINGS: '1' },
      encoding: 'utf8', timeout: 10000
    });
  assert.equal(result.signal, null, result.stderr || result.error?.message);
  return { status: result.status,
    body: JSON.parse(result.status === 0 ? result.stdout : result.stderr) };
}

function value(result) {
  assert.equal(result.ok, true, result.message);
  return result.value;
}

function denied(result, code = 'PROJECT_PATH_FORBIDDEN') {
  assert.equal(result.ok, false);
  assert.equal(result.code, code, result.message);
}

function mode(target) {
  return fs.statSync(target).mode & 0o777;
}

function downgradeToV1(f) {
  const directory = value(invoke(f, 'ensure', f.root, { create: true }));
  const marker = `${directory}.authority.json`;
  for (const file of [marker, path.join(directory, '.project-root.json')]) {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete current.birthtimeNs;
    current.version = 1;
    fs.writeFileSync(file, `${JSON.stringify(current)}\n`, { mode: 0o600 });
  }
  return directory;
}

function upgradeOptions(receipt) {
  return { confirmedOffline: true, confirmedHistoricalRoot: true, expectedReceipt: receipt };
}

test('path derivation is read-only, hashes canonical roots, and uses lexical missing roots', (t) => {
  const f = fixture(t);
  const alias = path.join(f.sandbox, 'alias');
  fs.symlinkSync(f.root, alias, 'dir');
  const expected = path.join(f.home, '.hello-cc', 'projects',
    createHash('sha256').update(fs.realpathSync(f.root)).digest('hex'));
  assert.equal(value(invoke(f, 'base')), path.join(f.home, '.hello-cc'));
  assert.equal(value(invoke(f, 'path')), expected);
  assert.equal(value(invoke(f, 'path', alias)), expected);
  const missing = path.join(f.sandbox, 'missing');
  assert.equal(value(invoke(f, 'path', missing)), path.join(f.home, '.hello-cc', 'projects',
    createHash('sha256').update(path.resolve(missing)).digest('hex')));
  denied(invoke(f, 'ensure', missing), 'PROJECT_NOT_REGISTERED');
  assert.equal(fs.existsSync(path.join(f.home, '.hello-cc')), false);
});

test('pure path derivation tolerates a missing HOME without creating it', (t) => {
  const f = fixture(t);
  fs.rmdirSync(f.home);
  assert.equal(value(invoke(f, 'base')), path.join(f.home, '.hello-cc'));
  assert.equal(value(invoke(f, 'path')), path.join(f.home, '.hello-cc', 'projects',
    createHash('sha256').update(fs.realpathSync(f.root)).digest('hex')));
  denied(invoke(f, 'ensure', f.root, { create: true }));
  assert.equal(fs.existsSync(f.home), false);
});

test('read-only lookup never creates or chmods; create establishes 0700 store and inode manifest', (t) => {
  const f = fixture(t);
  const base = path.join(f.home, '.hello-cc');
  assert.equal(value(invoke(f, 'ensure')), null);
  assert.equal(fs.existsSync(base), false);
  fs.mkdirSync(base, { mode: 0o755 });
  assert.equal(value(invoke(f, 'ensure')), null);
  assert.equal(mode(base), 0o755);

  const directory = value(invoke(f, 'ensure', f.root, { create: true }));
  assert.equal(directory, value(invoke(f, 'path')));
  assert.equal(mode(base), 0o700);
  assert.equal(mode(path.dirname(directory)), 0o700);
  assert.equal(mode(directory), 0o700);
  const manifestPath = path.join(directory, '.project-root.json');
  assert.equal(mode(manifestPath), 0o600);
  const stat = fs.statSync(f.root, { bigint: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), {
    version: 2,
    canonicalRoot: fs.realpathSync(f.root),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString()
  });

  fs.chmodSync(base, 0o755);
  assert.equal(value(invoke(f, 'ensure')), directory);
  assert.equal(mode(base), 0o755);
  assert.equal(value(invoke(f, 'ensure', f.root, { create: true })), directory);
  assert.equal(mode(base), 0o700);
});

test('interrupted first authority publication leaves no partial final marker and can be retried', (t) => {
  const f = fixture(t);
  const directory = value(invoke(f, 'path'));
  denied(invoke(f, 'fail-authority-publish', f.root, { create: true }));
  assert.equal(fs.existsSync(`${directory}.authority.json`), false);
  assert.equal(fs.existsSync(directory), false);
  assert.equal(fs.readdirSync(path.dirname(directory)).some((name) => name.includes('.authority.json.tmp-')), false);
  assert.equal(value(invoke(f, 'ensure', f.root, { create: true })), directory);
  assert.equal(JSON.parse(fs.readFileSync(`${directory}.authority.json`, 'utf8')).kind, 'fresh');
});

test('private v2 creation refuses unavailable or non-bigint directory birth times before binding publication', t => {
  const f = fixture(t);
  const directory = value(invoke(f, 'path'));
  for (const birthtimeKind of ['zero', 'negative', 'missing', 'string']) {
    denied(invoke(f, 'invalid-birthtime', f.root, { create: true, birthtimeKind }));
    assert.equal(fs.existsSync(directory), false, birthtimeKind);
    assert.equal(fs.existsSync(`${directory}.authority.json`), false, birthtimeKind);
  }
});

test('direct private-state initialization refuses an unmigrated legacy store', (t) => {
  const f = fixture(t);
  const legacy = path.join(f.root, '.hello-cc');
  fs.mkdirSync(legacy, { mode: 0o700 });
  fs.writeFileSync(path.join(legacy, 'mesh.db'), 'old-data', { mode: 0o600 });
  denied(invoke(f, 'ensure', f.root, { create: true }), 'STATE_MIGRATION_REQUIRED');
  const privateDir = value(invoke(f, 'path'));
  assert.equal(fs.existsSync(privateDir), false);
  assert.equal(fs.existsSync(`${privateDir}.authority.json`), false);
  assert.equal(fs.readFileSync(path.join(legacy, 'mesh.db'), 'utf8'), 'old-data');
});

test('interrupted manifest publication leaves an empty pending directory that can be retried', (t) => {
  const f = fixture(t);
  const directory = value(invoke(f, 'path'));
  denied(invoke(f, 'fail-manifest-publish', f.root, { create: true }));
  assert.equal(JSON.parse(fs.readFileSync(`${directory}.authority.json`, 'utf8')).kind, 'pending');
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(value(invoke(f, 'ensure', f.root, { create: true })), directory);
  assert.equal(JSON.parse(fs.readFileSync(`${directory}.authority.json`, 'utf8')).kind, 'fresh');
});

test('a writable project root is accepted but replacement at the same path cannot reuse state', (t) => {
  const f = fixture(t);
  fs.chmodSync(f.root, 0o777);
  const directory = value(invoke(f, 'ensure', f.root, { create: true }));
  fs.renameSync(f.root, `${f.root}-old`);
  fs.mkdirSync(f.root, { mode: 0o777 });
  assert.equal(value(invoke(f, 'path')), directory);
  denied(invoke(f, 'ensure'));
  denied(invoke(f, 'ensure', f.root, { create: true }));
});

test('explicit private generation keeps A intact, isolates B, and fences v1 binaries', (t) => {
  const f = fixture(t);
  fs.chmodSync(f.root, 0o777);
  const oldDir = value(invoke(f, 'ensure', f.root, { create: true }));
  fs.writeFileSync(path.join(oldDir, 'sentinel'), 'A-only', { mode: 0o600 });
  fs.renameSync(f.root, `${f.root}-old`);
  fs.mkdirSync(f.root, { mode: 0o777 });
  fs.chmodSync(f.root, 0o777);
  denied(invoke(f, 'ensure'));
  const next = value(invoke(f, 'provision'));
  assert.notEqual(next, oldDir);
  assert.equal(next, value(invoke(f, 'path')));
  assert.equal(JSON.parse(fs.readFileSync(`${oldDir}.authority.json`, 'utf8')).version, 2);
  assert.equal(JSON.parse(fs.readFileSync(`${oldDir}.authority.json`, 'utf8')).fence, 'legacy-v2');
  assert.equal(value(invoke(f, 'ensure', f.root, { create: true })), next);
  assert.equal(JSON.parse(fs.readFileSync(path.join(next, '.project-root.json'), 'utf8')).version, 2);
  fs.writeFileSync(path.join(next, 'sentinel'), 'B-only', { mode: 0o600 });
  assert.equal(fs.readFileSync(path.join(oldDir, 'sentinel'), 'utf8'), 'A-only');
  assert.equal(fs.readFileSync(path.join(next, 'sentinel'), 'utf8'), 'B-only');
  assert.equal(value(invoke(f, 'purge')), next);
  assert.equal(fs.readFileSync(path.join(oldDir, 'sentinel'), 'utf8'), 'A-only');
  assert.equal(JSON.parse(fs.readFileSync(value(invoke(f, 'authority')), 'utf8')).kind, 'reset');
  fs.renameSync(f.root, `${f.root}-new`);
  fs.renameSync(`${f.root}-old`, f.root);
  assert.equal(value(invoke(f, 'ensure')), oldDir); // v2 A retains its full identity.
  assert.equal(fs.readFileSync(path.join(oldDir, 'sentinel'), 'utf8'), 'A-only');
});

test('interrupted B publication leaves A fenced and a deliberate retry creates one generation', (t) => {
  const f = fixture(t);
  fs.chmodSync(f.root, 0o777);
  const oldDir = value(invoke(f, 'ensure', f.root, { create: true }));
  fs.renameSync(f.root, `${f.root}-old`);
  fs.mkdirSync(f.root, { mode: 0o777 });
  fs.chmodSync(f.root, 0o777);
  denied(invoke(f, 'fail-generation-publish'), 'EIO');
  assert.equal(JSON.parse(fs.readFileSync(`${oldDir}.authority.json`, 'utf8')).version, 2);
  denied(invoke(f, 'ensure'));
  const next = value(invoke(f, 'provision'));
  assert.equal(value(invoke(f, 'ensure', f.root, { create: true })), next);
  assert.equal(fs.readdirSync(`${oldDir}.generations`).filter(name => name.endsWith('.authority.json')).length, 1);
});

test('zero-birthtime generation and fence markers never authorize replacement state', t => {
  const f = fixture(t);
  const oldDir = value(invoke(f, 'ensure', f.root, { create: true }));
  fs.writeFileSync(path.join(oldDir, 'A-only'), 'preserved', { mode: 0o600 });
  fs.renameSync(f.root, `${f.root}-old`);
  fs.mkdirSync(f.root, { mode: 0o755 });
  const next = value(invoke(f, 'provision'));
  const generationMarker = value(invoke(f, 'authority'));
  const authority = JSON.parse(fs.readFileSync(generationMarker, 'utf8'));
  fs.writeFileSync(generationMarker, `${JSON.stringify({ ...authority, birthtimeNs: '0' })}\n`);
  denied(invoke(f, 'path'));
  fs.writeFileSync(generationMarker, `${JSON.stringify(authority)}\n`);
  const originalMarker = `${oldDir}.authority.json`;
  const fence = JSON.parse(fs.readFileSync(originalMarker, 'utf8'));
  fs.writeFileSync(originalMarker, `${JSON.stringify({ ...fence, birthtimeNs: '0' })}\n`);
  denied(invoke(f, 'path'));
  assert.equal(fs.existsSync(next), false);
  assert.equal(fs.readFileSync(path.join(oldDir, 'A-only'), 'utf8'), 'preserved');
});

test('a retained v2 store with zero birth time cannot be fenced into a replacement generation', t => {
  const f = fixture(t);
  const oldDir = value(invoke(f, 'ensure', f.root, { create: true }));
  fs.writeFileSync(path.join(oldDir, 'A-only'), 'preserved', { mode: 0o600 });
  for (const file of [`${oldDir}.authority.json`, path.join(oldDir, '.project-root.json')]) {
    const contents = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, `${JSON.stringify({ ...contents, birthtimeNs: '0' })}\n`);
  }
  const before = fs.readFileSync(`${oldDir}.authority.json`, 'utf8');
  fs.renameSync(f.root, `${f.root}-old`);
  fs.mkdirSync(f.root, { mode: 0o755 });
  denied(invoke(f, 'provision'));
  assert.equal(fs.readFileSync(`${oldDir}.authority.json`, 'utf8'), before);
  assert.equal(fs.existsSync(`${oldDir}.generations`), false);
  assert.equal(fs.readFileSync(path.join(oldDir, 'A-only'), 'utf8'), 'preserved');
});

test('orphan generation entries and missing B state never fall back to A', t => {
  const f = fixture(t);
  fs.chmodSync(f.root, 0o777);
  const oldDir = value(invoke(f, 'ensure', f.root, { create: true }));
  fs.writeFileSync(path.join(oldDir, 'A-only'), 'retained', { mode: 0o600 });
  fs.renameSync(f.root, `${f.root}-old`);
  fs.mkdirSync(f.root, { mode: 0o777 });
  fs.chmodSync(f.root, 0o777);
  const next = value(invoke(f, 'provision'));
  const orphan = path.join(path.dirname(next), 'c'.repeat(32));
  fs.mkdirSync(orphan, { mode: 0o700 });
  denied(invoke(f, 'path'));
  fs.rmdirSync(orphan);
  assert.equal(value(invoke(f, 'ensure', f.root, { create: true })), next);
  fs.rmSync(next, { recursive: true });
  denied(invoke(f, 'ensure'), 'STATE_AUTHORITY_MISSING');
  denied(invoke(f, 'ensure', f.root, { create: true }), 'STATE_AUTHORITY_MISSING');
  assert.equal(fs.readFileSync(path.join(oldDir, 'A-only'), 'utf8'), 'retained');
});

test('historical v1 store fails closed even when dev and ino match, until asserted offline upgrade', t => {
  const f = fixture(t);
  const directory = downgradeToV1(f);
  fs.writeFileSync(path.join(directory, 'sentinel'), 'A preserved', { mode: 0o600 });
  denied(invoke(f, 'ensure'), 'STATE_BINDING_UPGRADE_REQUIRED');
  denied(invoke(f, 'provision'), 'STATE_BINDING_UPGRADE_REQUIRED');
  const inspection = value(invoke(f, 'inspect-upgrade'));
  assert.equal(inspection.status, 'required');
  assert.match(inspection.warning, /not proof/);
  denied(invoke(f, 'upgrade', f.root, upgradeOptions('0'.repeat(64))),
    'STATE_BINDING_UPGRADE_RECEIPT_MISMATCH');
  denied(invoke(f, 'upgrade', f.root, { expectedReceipt: inspection.receipt }),
    'STATE_BINDING_UPGRADE_CONFIRMATION_REQUIRED');
  assert.equal(value(invoke(f, 'upgrade', f.root, upgradeOptions(inspection.receipt))).status, 'upgraded');
  assert.equal(value(invoke(f, 'ensure')), directory);
  assert.equal(fs.readFileSync(path.join(directory, 'sentinel'), 'utf8'), 'A preserved');
  assert.equal(JSON.parse(fs.readFileSync(`${directory}.authority.json`, 'utf8')).version, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, '.project-root.json'), 'utf8')).version, 2);
});

test('private v1 upgrade refuses observable live writer and keeps historical state unchanged', t => {
  const f = fixture(t);
  const directory = downgradeToV1(f);
  fs.writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify({ pid: process.pid }),
    { mode: 0o600 });
  const receipt = value(invoke(f, 'inspect-upgrade')).receipt;
  denied(invoke(f, 'upgrade', f.root, upgradeOptions(receipt)), 'STATE_MIGRATION_UNSAFE');
  assert.equal(JSON.parse(fs.readFileSync(`${directory}.authority.json`, 'utf8')).version, 1);
});

test('private v1 upgrade detects an active native owner even without its pointer', t => {
  const f = fixture(t);
  const directory = downgradeToV1(f);
  const nativeDir = path.join(directory, 'native');
  fs.mkdirSync(nativeDir, { mode: 0o700 });
  const db = new DatabaseSync(path.join(nativeDir, 'state.db'));
  db.exec('CREATE TABLE native_owner(singleton INTEGER PRIMARY KEY, pid INTEGER, start_token TEXT, command_hash TEXT, state TEXT)');
  db.prepare('INSERT INTO native_owner VALUES (1, ?, ?, ?, ?)')
    .run(process.pid, '', '', 'active');
  db.close();
  fs.chmodSync(path.join(nativeDir, 'state.db'), 0o600);
  const receipt = value(invoke(f, 'inspect-upgrade')).receipt;
  denied(invoke(f, 'upgrade', f.root, upgradeOptions(receipt)), 'STATE_MIGRATION_UNSAFE');
  assert.equal(JSON.parse(fs.readFileSync(`${directory}.authority.json`, 'utf8')).version, 1);
});

test('private v1 upgrade fences first and retries safely after manifest publication failure', t => {
  const f = fixture(t);
  const directory = downgradeToV1(f);
  const receipt = value(invoke(f, 'inspect-upgrade')).receipt;
  denied(invoke(f, 'fail-upgrade-manifest', f.root, upgradeOptions(receipt)), 'EIO');
  const authority = JSON.parse(fs.readFileSync(`${directory}.authority.json`, 'utf8'));
  assert.equal(authority.version, 2);
  assert.equal(authority.fence, 'upgrade-pending');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, '.project-root.json'), 'utf8')).version, 1);
  denied(invoke(f, 'ensure'));
  assert.equal(value(invoke(f, 'inspect-upgrade')).receipt, receipt);
  assert.equal(value(invoke(f, 'upgrade', f.root, upgradeOptions(receipt))).status, 'upgraded');
  assert.equal(value(invoke(f, 'ensure')), directory);
});

test('private v1 upgrade keeps the pending fence when the second offline check fails', t => {
  const f = fixture(t);
  const directory = downgradeToV1(f);
  const receipt = value(invoke(f, 'inspect-upgrade')).receipt;
  denied(invoke(f, 'fail-upgrade-after-check', f.root, upgradeOptions(receipt)),
    'STATE_BINDING_UPGRADE_OFFLINE_REQUIRED');
  assert.equal(JSON.parse(fs.readFileSync(`${directory}.authority.json`, 'utf8')).fence,
    'upgrade-pending');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, '.project-root.json'), 'utf8')).version, 2);
  denied(invoke(f, 'ensure'));
  assert.equal(value(invoke(f, 'inspect-upgrade')).receipt, receipt);
  assert.equal(value(invoke(f, 'upgrade', f.root, upgradeOptions(receipt))).status, 'upgraded');
});

test('CLI requires inspection, offline assertion, and exact receipt before v1 binding upgrade', t => {
  const f = fixture(t);
  const directory = downgradeToV1(f);
  const ordinary = invokeCli(f, [], 'status');
  assert.notEqual(ordinary.status, 0);
  assert.equal(ordinary.body.error.code, 'STATE_BINDING_UPGRADE_REQUIRED');
  const deniedRead = invokeCli(f, ['--inspect-private-binding']);
  assert.equal(deniedRead.status, 0);
  assert.equal(deniedRead.body.data.status, 'required');
  const receipt = deniedRead.body.data.receipt;
  const missingAssertion = invokeCli(f, [
    '--upgrade-private-binding', '--offline', '--yes', `--expect-receipt=${receipt}`
  ]);
  assert.notEqual(missingAssertion.status, 0);
  assert.equal(missingAssertion.body.error.code, 'STATE_BINDING_UPGRADE_CONFIRMATION_REQUIRED');
  const upgrade = invokeCli(f, ['--upgrade-private-binding', '--offline', '--yes',
    '--assert-historical-root', `--expect-receipt=${receipt}`]);
  assert.equal(upgrade.status, 0, JSON.stringify(upgrade.body));
  assert.equal(upgrade.body.data.status, 'upgraded');
  assert.equal(value(invoke(f, 'ensure')), directory);
});

test('v1 metadata matching replacement B cannot be treated as A even with a reused inode tuple', t => {
  const f = fixture(t);
  const oldDir = downgradeToV1(f);
  fs.renameSync(f.root, `${f.root}-old`);
  fs.mkdirSync(f.root, { mode: 0o755 });
  // Simulate an ABA dev/ino reuse: a v1 marker carries exactly B's tuple.
  const b = fs.statSync(f.root, { bigint: true });
  for (const file of [`${oldDir}.authority.json`, path.join(oldDir, '.project-root.json')]) {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    current.dev = b.dev.toString();
    current.ino = b.ino.toString();
    fs.writeFileSync(file, `${JSON.stringify(current)}\n`, { mode: 0o600 });
  }
  denied(invoke(f, 'ensure'), 'STATE_BINDING_UPGRADE_REQUIRED');
  denied(invoke(f, 'provision'), 'STATE_BINDING_UPGRADE_REQUIRED');
});

test('historical v1 A must be upgraded offline before B can get a generation', t => {
  const f = fixture(t);
  const oldDir = downgradeToV1(f);
  fs.writeFileSync(path.join(oldDir, 'A-only'), 'original A bytes', { mode: 0o600 });
  const authorityPath = `${oldDir}.authority.json`;
  const historicalAuthority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
  delete historicalAuthority.kind; // Earliest v1 markers implicitly meant migrated.
  fs.writeFileSync(authorityPath, `${JSON.stringify(historicalAuthority)}\n`, { mode: 0o600 });
  const beforeAuthority = fs.readFileSync(authorityPath, 'utf8');
  const beforeManifest = fs.readFileSync(path.join(oldDir, '.project-root.json'), 'utf8');
  fs.renameSync(f.root, `${f.root}-old`);
  fs.mkdirSync(f.root, { mode: 0o755 });
  denied(invoke(f, 'provision'), 'STATE_BINDING_UPGRADE_REQUIRED');
  assert.equal(fs.readFileSync(authorityPath, 'utf8'), beforeAuthority);
  assert.equal(fs.readFileSync(path.join(oldDir, '.project-root.json'), 'utf8'), beforeManifest);
  assert.equal(fs.existsSync(`${oldDir}.generations`), false);

  // The operator restores independently verified A, cold-drains all writers,
  // and explicitly upgrades its complete v1 binding before selecting B.
  fs.renameSync(f.root, `${f.root}-new`);
  fs.renameSync(`${f.root}-old`, f.root);
  const receipt = value(invoke(f, 'inspect-upgrade')).receipt;
  assert.equal(value(invoke(f, 'upgrade', f.root, upgradeOptions(receipt))).status, 'upgraded');
  fs.renameSync(f.root, `${f.root}-old`);
  fs.renameSync(`${f.root}-new`, f.root);
  const next = value(invoke(f, 'provision'));
  assert.notEqual(next, oldDir);
  assert.equal(value(invoke(f, 'ensure', f.root, { create: true })), next);
  fs.writeFileSync(path.join(next, 'B-only'), 'replacement B bytes', { mode: 0o600 });
  assert.equal(fs.readFileSync(path.join(oldDir, 'A-only'), 'utf8'), 'original A bytes');
  assert.equal(fs.existsSync(path.join(next, 'A-only')), false);
  fs.renameSync(f.root, `${f.root}-new`);
  fs.renameSync(`${f.root}-old`, f.root);
  assert.equal(value(invoke(f, 'ensure')), oldDir);
  assert.equal(fs.existsSync(path.join(oldDir, 'B-only')), false);
});

test('historical v1 pending state without a manifest requires manual recovery, not purge', t => {
  const f = fixture(t);
  const directory = downgradeToV1(f);
  fs.unlinkSync(path.join(directory, '.project-root.json'));
  const marker = `${directory}.authority.json`;
  const authority = JSON.parse(fs.readFileSync(marker, 'utf8'));
  fs.writeFileSync(marker, `${JSON.stringify({ ...authority, kind: 'pending' })}\n`, { mode: 0o600 });
  denied(invoke(f, 'ensure'), 'STATE_BINDING_UPGRADE_REQUIRED');
  denied(invoke(f, 'inspect-upgrade'), 'STATE_BINDING_MANUAL_RECOVERY_REQUIRED');
  denied(invoke(f, 'purge'), 'STATE_BINDING_UPGRADE_REQUIRED');
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).version, 1);
});

test('an uncommitted nonempty state directory is never adopted', (t) => {
  const f = fixture(t);
  const directory = value(invoke(f, 'path'));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'partial.db'), 'sentinel');
  denied(invoke(f, 'ensure'));
  denied(invoke(f, 'ensure', f.root, { create: true }));
  assert.equal(fs.existsSync(path.join(directory, '.project-root.json')), false);
  assert.equal(fs.readFileSync(path.join(directory, 'partial.db'), 'utf8'), 'sentinel');
});

test('store and manifest symlinks are rejected without touching targets', (t) => {
  const f = fixture(t);
  const external = path.join(f.sandbox, 'external');
  fs.mkdirSync(external, { mode: 0o700 });
  const base = path.join(f.home, '.hello-cc');
  fs.symlinkSync(external, base, 'dir');
  denied(invoke(f, 'ensure', f.root, { create: true }));
  assert.deepEqual(fs.readdirSync(external), []);
  fs.unlinkSync(base);

  const directory = value(invoke(f, 'ensure', f.root, { create: true }));
  const manifestPath = path.join(directory, '.project-root.json');
  const sentinel = path.join(external, 'sentinel');
  fs.writeFileSync(sentinel, 'untouched', { mode: 0o600 });
  fs.unlinkSync(manifestPath);
  fs.symlinkSync(sentinel, manifestPath, 'file');
  denied(invoke(f, 'ensure'));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
});

test('projects and per-project directories cannot be symlinks', (t) => {
  const f = fixture(t);
  const external = path.join(f.sandbox, 'external');
  fs.mkdirSync(external, { mode: 0o700 });
  const directory = value(invoke(f, 'path'));
  const projects = path.dirname(directory);
  fs.mkdirSync(path.dirname(projects), { mode: 0o700 });
  fs.symlinkSync(external, projects, 'dir');
  denied(invoke(f, 'ensure', f.root, { create: true }));
  fs.unlinkSync(projects);
  fs.mkdirSync(projects, { mode: 0o700 });
  fs.symlinkSync(external, directory, 'dir');
  denied(invoke(f, 'ensure', f.root, { create: true }));
  assert.deepEqual(fs.readdirSync(external), []);
});

test('manifest hardlinks are refused', (t) => {
  const f = fixture(t);
  const directory = value(invoke(f, 'ensure', f.root, { create: true }));
  fs.linkSync(path.join(directory, '.project-root.json'), path.join(f.sandbox, 'linked-manifest'));
  denied(invoke(f, 'ensure'));
});

test('nonsticky writable home ancestry is refused; sticky /tmp with an owned child is safe', (t) => {
  const f = fixture(t);
  const unsafe = path.join(f.sandbox, 'writable');
  fs.mkdirSync(unsafe, { mode: 0o777 });
  fs.chmodSync(unsafe, 0o777);
  const badHome = path.join(unsafe, 'home');
  fs.mkdirSync(badHome, { mode: 0o700 });
  denied(invoke({ ...f, home: badHome }, 'ensure', f.root, { create: true }));
  assert.equal(fs.existsSync(path.join(badHome, '.hello-cc')), false);

  const stickyParent = fs.realpathSync('/tmp');
  if ((fs.statSync(stickyParent).mode & 0o1777) !== 0o1777) return;
  const stickySandbox = fs.mkdtempSync(path.join(stickyParent, 'hcc-private-sticky-'));
  t.after(() => fs.rmSync(stickySandbox, { recursive: true, force: true }));
  const stickyHome = path.join(stickySandbox, 'home');
  fs.mkdirSync(stickyHome, { mode: 0o700 });
  const result = invoke({ ...f, home: stickyHome }, 'ensure', f.root, { create: true });
  assert.equal(mode(value(result)), 0o700);
});

test('global state path rejects a writable or redirected parent before exposing runtime pointers', (t) => {
  const f = fixture(t);
  const global = path.join(f.home, '.hello-cc');
  assert.equal(value(invoke(f, 'global')), global);
  assert.equal(fs.existsSync(global), false);
  fs.mkdirSync(global, { mode: 0o700 });
  assert.equal(value(invoke(f, 'global')), global);
  fs.chmodSync(global, 0o777);
  denied(invoke(f, 'global'));
  fs.rmSync(global, { recursive: true });
  const outside = path.join(f.sandbox, 'outside');
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.symlinkSync(outside, global, 'dir');
  denied(invoke(f, 'global'));
});
