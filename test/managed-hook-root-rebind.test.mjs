import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hcc = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));

test('a managed hook cannot rebind an initialized A project to replacement B',
  { skip: process.platform === 'win32' }, t => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-hook-rebind-')));
    const shared = path.join(base, 'shared');
    const root = path.join(shared, 'chosen');
    const moved = path.join(shared, 'original');
    const home = path.join(base, 'home');
    fs.mkdirSync(shared, { mode: 0o777 });
    fs.chmodSync(shared, 0o777);
    fs.mkdirSync(root);
    fs.mkdirSync(home, { mode: 0o700 });
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const env = { ...process.env, HOME: home, HCC_RUNTIME_URL: '', NODE_NO_WARNINGS: '1' };
    const cli = (args, extraEnv = env, input = '') => spawnSync(process.execPath,
      [hcc, '--root', root, '--json', ...args], {
        cwd: base, env: extraEnv, input, encoding: 'utf8', timeout: 10000
      });
    const init = cli(['init', '--no-guidance']);
    assert.equal(init.status, 0, init.stderr || init.stdout);
    const dbPath = JSON.parse(init.stdout).data.db;
    const registry = path.join(home, '.hello-cc', 'projects.json');
    const registryBefore = fs.existsSync(registry) ? fs.readFileSync(registry) : null;
    const count = () => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try { return db.prepare('SELECT COUNT(*) AS n FROM events').get().n; }
      finally { db.close(); }
    };
    const before = count();
    fs.renameSync(root, moved);
    fs.mkdirSync(root);
    const hook = cli(['hook', 'sessionstart', '--provider', 'claude'], {
      ...env, HCC_ROOT: root, HCC_DB: dbPath, HCC_PEER: 'managed-a'
    }, JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'managed-a', cwd: root }));
    assert.notEqual(hook.status, 0, hook.stdout);
    assert.match(hook.stderr, /PROJECT_PATH_FORBIDDEN|Project root identity differs|STATE_/);
    assert.equal(count(), before);
    assert.equal(fs.existsSync(path.join(root, '.hello-cc', 'mesh.db')), false);
    assert.deepEqual(fs.existsSync(registry) ? fs.readFileSync(registry) : null, registryBefore);
  });
