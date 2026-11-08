import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Exercise the workflow's actual mode-selection block, not a second copy of
// its branching logic. Stub only the subprocess that would pack/install HCC.
const workflow = fs.readFileSync(new URL('../.github/workflows/dsh-acceptance.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const packageStep = workflow.split('name: Freeze selected package and record candidate or release provenance')[1]
  .split('\n      - name:')[0];
const program = packageStep.split("<<'NODE'\n")[1].split('\n          NODE')[0]
  .replace(/^          /gm, '');
const repo = new URL('..', import.meta.url);

for (const [event, ref, dispatchMode, expected] of [
  ['push', 'refs/heads/master', '', 'candidate'],
  ['push', 'refs/heads/codex/feature', '', 'candidate'],
  ['pull_request', 'refs/pull/1/merge', '', 'candidate'],
  ['push', 'refs/tags/v1.1.6', '', 'release'],
  ['workflow_dispatch', 'refs/heads/master', '', 'release'],
  ['workflow_dispatch', 'refs/heads/master', 'candidate', 'candidate'],
  ['workflow_dispatch', 'refs/tags/v1.1.6', 'candidate', 'release']
]) {
  test(`Harness workflow selects ${expected} for ${event} ${ref} ${dispatchMode}`, () => {
    const prelude = `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      childProcess.spawnSync = (command, args) => {
        console.log('SELECTED_MODE=' + args[args.indexOf('--mode') + 1]);
        return { status: 0 };
      };
      syncBuiltinESMExports();
    `;
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: prelude + program, cwd: repo, encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF: ref,
        HCC_DSH_DISPATCH_MODE: dispatchMode }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`SELECTED_MODE=${expected}(?:\\r?\\n|$)`));
  });
}
