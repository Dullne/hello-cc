import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const crossUidAvailable = process.platform === 'linux' &&
  typeof process.getuid === 'function' && process.getuid() === 0;

test('a different UID cannot redirect a captured launch by replacing its parent entry',
  { skip: !crossUidAvailable }, async t => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-pinned-cross-uid-'));
    const parent = path.join(fixture, 'shared');
    const original = path.join(parent, 'chosen');
    const moved = path.join(parent, 'original');
    const bootstrap = path.join(fixture, 'bootstrap');
    fs.chmodSync(fixture, 0o755);
    fs.mkdirSync(parent, { mode: 0o777 });
    fs.chownSync(parent, 2002, 2002);
    fs.mkdirSync(original, { mode: 0o700 });
    fs.chownSync(original, 2001, 2001);
    fs.mkdirSync(bootstrap, { mode: 0o700 });
    fs.chownSync(bootstrap, 2001, 2001);
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

    // A runner checkout can live below a private home. The other UID needs
    // readable copies of public test subjects, not access to that home.
    // Keep this staging root-owned and unwritable by either child UID.
    const source = path.join(fixture, 'source');
    fs.cpSync(new URL('../lib/', import.meta.url), source, { recursive: true });
    fs.chmodSync(source, 0o755);
    for (const relative of fs.readdirSync(source, { recursive: true })) {
      const target = path.join(source, relative);
      const stat = fs.lstatSync(target);
      assert.ok(stat.isDirectory() || stat.isFile(), 'Staged test sources must be ordinary files or directories');
      fs.chmodSync(target, stat.isDirectory() ? 0o755 : 0o644);
    }
    const moduleUrl = pathToFileURL(path.join(source, 'process/pinned-cwd.mjs')).href;
    const ownerSource = `
      import { spawnSync } from 'node:child_process';
      import { preparePinnedCwdLaunch } from ${JSON.stringify(moduleUrl)};
      const binding = preparePinnedCwdLaunch(${JSON.stringify(original)}, process.execPath,
        ['-e', 'require("node:fs").writeFileSync("ran-marker", "wrong")'],
        { bootstrapCwd: ${JSON.stringify(bootstrap)} });
      process.stdout.write('READY\\n');
      process.stdin.once('data', () => {
        const result = spawnSync(binding.command, binding.args,
          { cwd: binding.cwd, env: binding.env, encoding: 'utf8' });
        binding.release();
        process.stdout.write(JSON.stringify({ status: result.status,
          stderr: result.stderr, error: result.error?.code || null }) + '\\n');
      });
    `;
    const owner = spawn(process.execPath, ['--input-type=module', '-e', ownerSource], {
      cwd: bootstrap, uid: 2001, gid: 2001,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', NODE_NO_WARNINGS: '1' }
    });
    let ownerStderr = '';
    owner.stderr.setEncoding('utf8');
    owner.stderr.on('data', chunk => { ownerStderr += chunk; });
    t.after(() => { if (owner.exitCode === null) owner.kill('SIGKILL'); });
    const lines = createInterface({ input: owner.stdout })[Symbol.asyncIterator]();
    const first = await Promise.race([
      lines.next(), delay(5000).then(() => { throw new Error('owner did not capture the original directory'); })
    ]);
    assert.equal(first.value, 'READY', ownerStderr);

    const attackerSource = `
      const fs = require('node:fs');
      fs.renameSync(${JSON.stringify(original)}, ${JSON.stringify(moved)});
      fs.mkdirSync(${JSON.stringify(original)}, { mode: 0o755 });
    `;
    const attacker = spawnSync(process.execPath, ['-e', attackerSource], {
      cwd: parent, uid: 2002, gid: 2002, encoding: 'utf8'
    });
    assert.equal(attacker.status, 0, attacker.stderr);
    owner.stdin.write('\n');
    const second = await Promise.race([
      lines.next(), delay(5000).then(() => { throw new Error('owner launch did not complete'); })
    ]);
    const result = JSON.parse(second.value);
    assert.equal(result.error, null);
    assert.equal(result.status, 41, result.stderr);
    assert.match(result.stderr, /HCC_PINNED_CWD_CHANGED:entry/);
    assert.equal(fs.existsSync(path.join(original, 'ran-marker')), false);
    assert.equal(fs.existsSync(path.join(moved, 'ran-marker')), false);
  });
