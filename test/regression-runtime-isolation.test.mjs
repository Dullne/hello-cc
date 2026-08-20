import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const regressionSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'regression.mjs'), 'utf8');

test('tmux GC fixtures stop the runtime before creating bulk synthetic sessions', () => {
  const workflow = regressionSource.match(
    /async function assertTmuxGcPolicy\(\) \{[\s\S]*?\n\}\n\nfunction /u
  )?.[0] || '';
  const activeStart = workflow.indexOf("hcc(['peer', 'start', eventPeer");
  const runtimeStop = workflow.indexOf('await stopRuntime()', activeStart);
  const firstSyntheticSession = workflow.indexOf("run('tmux', ['new-session'");

  assert.ok(activeStart >= 0, 'active authority fixture must be created through the runtime');
  assert.ok(runtimeStop > activeStart, 'runtime must stop after creating the active authority fixture');
  assert.ok(
    firstSyntheticSession > runtimeStop,
    'bulk synthetic tmux sessions must be created only after runtime auto-adoption is stopped'
  );
});
