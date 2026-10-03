import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMiscCommands } from '../lib/cli/commands/misc.mjs';
import { resolveProjectDatabase } from '../lib/runtime/project-path.mjs';
import { CliError } from '../lib/shared/errors.mjs';

test('down reclaims only the state route selected before a root alias changes', async (t) => {
  if (process.platform === 'win32') { t.skip('directory symlink permissions vary on Windows'); return; }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-down-alias-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const first = path.join(sandbox, 'first');
  const second = path.join(sandbox, 'second');
  const alias = path.join(sandbox, 'selected');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.symlinkSync(first, alias, 'dir');
  const selectedState = resolveProjectDatabase({ root: alias, createStateDir: false }).stateDir;
  const expectedPointer = path.join(selectedState, 'runtime.json');
  let reclaimedFiles = null;
  const commands = createMiscCommands({
    path,
    process: { env: {} },
    CliError,
    printResult: () => {},
    readRuntime: () => {
      fs.unlinkSync(alias);
      fs.symlinkSync(second, alias, 'dir');
      throw new CliError('RUNTIME_NOT_RUNNING', 'stale');
    },
    runtimeRequest: async () => {},
    runtimePath: () => { throw new Error('local pointer route was not pinned'); },
    globalRuntimePath: () => path.join(sandbox, 'global-runtime.json'),
    reclaimRuntimePointerFiles: (files) => {
      reclaimedFiles = files;
      return { reclaimed: 1, blocked: false };
    },
    PRODUCT_NAME: 'hello-cc'
  });

  await commands.cmdDown({ root: alias }, []);
  assert.equal(reclaimedFiles?.[0], expectedPointer);
  assert.notEqual(reclaimedFiles?.[0],
    path.join(resolveProjectDatabase({ root: alias, createStateDir: false }).stateDir, 'runtime.json'));
});
