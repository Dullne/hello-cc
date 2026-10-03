import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { writeGuidance, removeGuidanceBlocks } from '../lib/guidance.mjs';
import { writeProjectGuidanceFiles } from '../lib/process/pinned-guidance.mjs';
import { createInstallCommands } from '../lib/cli/commands/install.mjs';
import { parseOpts } from '../lib/cli-args.mjs';
import { CliError } from '../lib/shared/errors.mjs';
import { projectStateDir } from '../lib/runtime/paths.mjs';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-guidance-pinned-')));
  const root = path.join(base, 'selected');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root };
}

function spawnWithWorkerSwap(command, args, options, marker, source) {
  const modified = [...args];
  const launch = JSON.parse(modified[2]);
  assert.ok(launch.args[1].includes(marker), `missing worker marker ${marker}`);
  launch.args[1] = launch.args[1].replace(marker, source);
  modified[2] = JSON.stringify(launch);
  return spawnSync(command, modified, options);
}

test('guidance writes and removes blocks in the selected directory', t => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Existing note\n');
  const guidePath = writeGuidance(root);
  assert.match(fs.readFileSync(guidePath, 'utf8'), /hello-cc Coordination Rules/);
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    assert.match(fs.readFileSync(path.join(root, name), 'utf8'), /<!-- hello-cc:start -->/);
  }
  assert.equal(writeGuidance(root), guidePath);
  const changed = removeGuidanceBlocks(root);
  assert.equal(changed.length, 2);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), 'Existing note\n');
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '');
});

test('guidance refuses a symlink without writing through it or partially changing another file', t => {
  const { base, root } = fixture(t);
  const outside = path.join(base, 'outside.md');
  fs.writeFileSync(outside, 'outside sentinel\n');
  fs.symlinkSync(outside, path.join(root, 'AGENTS.md'));
  assert.throws(() => writeGuidance(root), { code: 'GUIDANCE_WRITE_FAILED' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside sentinel\n');
  assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md')), false);
});

test('guidance rejects a replacement before worker startup and never edits the replacement', t => {
  const { base, root } = fixture(t);
  const moved = path.join(base, 'original');
  assert.throws(() => writeProjectGuidanceFiles(root, 'safe guidance', {
    spawnProcess(command, args, options) {
      fs.renameSync(root, moved);
      fs.mkdirSync(root);
      return spawnSync(command, args, options);
    }
  }), { code: 'PROJECT_PATH_CHANGED' });
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    assert.equal(fs.existsSync(path.join(root, name)), false);
    assert.equal(fs.existsSync(path.join(moved, name)), false);
  }
});

test('HCC.md rename stays on the original state inode when the project root is replaced at rename', t => {
  if (process.platform === 'win32') return t.skip('POSIX directory identity required');
  const { base, root } = fixture(t);
  assert.equal(projectStateDir(root), path.join(root, '.hello-cc'));
  const moved = path.join(base, 'original');
  const replacement = path.join(base, 'replacement');
  fs.mkdirSync(path.join(replacement, '.hello-cc'), { recursive: true });
  fs.writeFileSync(path.join(replacement, '.hello-cc', 'HCC.md'), 'replacement sentinel\n');
  const source = `fs.renameSync(${JSON.stringify(root)}, ${JSON.stringify(moved)});` +
    `fs.renameSync(${JSON.stringify(replacement)}, ${JSON.stringify(root)});`;

  writeGuidance(root, { stateSpawnProcess: (command, args, options) =>
    spawnWithWorkerSwap(command, args, options,
      '/* PINNED_STATE_TEST_BEFORE_RENAME */', source) });

  assert.match(fs.readFileSync(path.join(moved, '.hello-cc', 'HCC.md'), 'utf8'),
    /hello-cc Coordination Rules/);
  assert.equal(fs.readFileSync(path.join(root, '.hello-cc', 'HCC.md'), 'utf8'),
    'replacement sentinel\n');
});

test('project-local purge removes only the originally selected root after an operation-time swap', async t => {
  if (process.platform === 'win32') return t.skip('POSIX directory identity required');
  const { base, root } = fixture(t);
  assert.equal(projectStateDir(root), path.join(root, '.hello-cc'));
  writeGuidance(root);
  fs.writeFileSync(path.join(root, '.hello-cc', 'original-data'), 'original sentinel\n');
  const moved = path.join(base, 'original');
  const replacement = path.join(base, 'replacement');
  fs.mkdirSync(path.join(replacement, '.hello-cc'), { recursive: true });
  fs.writeFileSync(path.join(replacement, '.hello-cc', 'replacement-data'), 'replacement sentinel\n');
  const source = `fs.renameSync(${JSON.stringify(root)}, ${JSON.stringify(moved)});` +
    `fs.renameSync(${JSON.stringify(replacement)}, ${JSON.stringify(root)});`;
  let receipt;
  const commands = createInstallCommands({
    path, fs, CliError, parseOpts,
    readRuntime: () => null,
    loadSetup: async () => ({
      uninstallClaudeHooks: () => false,
      uninstallCodexHooks: () => false,
      uninstallShims: () => [],
      uninstallPathEntry: () => ({ missing: true, rcFile: '.zshrc' })
    }),
    removeGuidanceBlocks: () => [],
    printResult: (_ctx, data) => { receipt = data; },
    spawnPinnedStateProcess: (command, args, options) =>
      spawnWithWorkerSwap(command, args, options,
        '/* PINNED_STATE_TEST_BEFORE_PURGE */', source)
  });

  await commands.cmdUninstall({ root, dbPath: path.join(root, '.hello-cc', 'mesh.db') },
    ['--purge', '--yes']);

  assert.equal(receipt.purge, true);
  assert.equal(fs.existsSync(path.join(moved, '.hello-cc')), false);
  assert.equal(fs.readFileSync(path.join(root, '.hello-cc', 'replacement-data'), 'utf8'),
    'replacement sentinel\n');
});

test('project-local purge remains a no-op when state is already absent', async t => {
  const { root } = fixture(t);
  assert.equal(projectStateDir(root), path.join(root, '.hello-cc'));
  let receipt;
  const commands = createInstallCommands({
    path, fs, CliError, parseOpts,
    readRuntime: () => null,
    loadSetup: async () => ({
      uninstallClaudeHooks: () => false,
      uninstallCodexHooks: () => false,
      uninstallShims: () => [],
      uninstallPathEntry: () => ({ missing: true, rcFile: '.zshrc' })
    }),
    removeGuidanceBlocks: () => [],
    printResult: (_ctx, data) => { receipt = data; }
  });

  await commands.cmdUninstall({ root, dbPath: path.join(root, '.hello-cc', 'mesh.db') },
    ['--purge', '--yes']);

  assert.equal(receipt.purge, true);
  assert.equal(fs.existsSync(path.join(root, '.hello-cc')), false);
});

test('uninstall aborts after an awaited stop if the selected root was replaced', async t => {
  const { base, root } = fixture(t);
  writeGuidance(root);
  const moved = path.join(base, 'original');
  let removedHooks = false;
  const commands = createInstallCommands({
    path, fs, CliError, parseOpts,
    readRuntime: () => ({ pid: 12345 }),
    runtimeRequest: async () => {
      fs.renameSync(root, moved);
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'replacement sentinel\n');
    },
    loadSetup: async () => ({
      uninstallClaudeHooks: () => { removedHooks = true; return false; },
      uninstallCodexHooks: () => false,
      uninstallShims: () => [],
      uninstallPathEntry: () => ({ missing: true, rcFile: '.zshrc' })
    }),
    removeGuidanceBlocks: () => assert.fail('must not edit guidance after replacement')
  });
  await assert.rejects(commands.cmdUninstall({ root, dbPath: path.join(root, '.hello-cc', 'mesh.db') },
    ['--purge', '--yes']), { code: 'PROJECT_PATH_CHANGED' });
  assert.equal(removedHooks, false);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), 'replacement sentinel\n');
  assert.match(fs.readFileSync(path.join(moved, 'CLAUDE.md'), 'utf8'), /<!-- hello-cc:start -->/);
});
