import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureFailureError, fixtureFailureDiagnostic, fixtureTmuxGcSummary } from '../scripts/regression.mjs';

test('tmux GC diagnostics retain fixture roles and finite skip reasons without session or process data', () => {
  const observation = {
    stale: { candidate: true, reason: 'stale_hcc_managed_session', mode: 'explicit_exit_live' },
    deadBinding: { candidate: false, reason: 'tmux_dead_process_pid_changed', pid: 123, session: 'PRIVATE_SESSION' },
    deadEvent: { candidate: false, reason: 'tmux_process_not_confirmed_dead', output: 'PRIVATE_OUTPUT' },
    peerFilter: { candidate: 'true', reason: 'PRIVATE_REASON', mode: 'PRIVATE_MODE' },
    secret: 'PRIVATE_SECRET'
  };
  const error = fixtureFailureError('PRIVATE_MESSAGE', observation, 'tmux-gc');
  const saved = fixtureFailureDiagnostic(error).tmuxGc;
  assert.deepEqual(saved.stale, { candidate: true, reason: 'stale_hcc_managed_session', mode: 'explicit_exit_live' });
  assert.equal(saved.deadBinding.reason, 'tmux_dead_process_pid_changed');
  assert.deepEqual(saved.peerFilter, { candidate: null, reason: 'unknown', mode: null });
  observation.deadBinding.reason = 'PRIVATE_CHANGED';
  assert.equal(saved.deadBinding.reason, 'tmux_dead_process_pid_changed');
  assert.ok(Object.isFrozen(saved));
  assert.ok(Object.isFrozen(saved.deadBinding));
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_|output|secret/);
  for (const value of Object.values(saved)) assert.deepEqual(Object.keys(value), ['candidate', 'reason', 'mode']);
});

test('only the explicit fixture failure operation can attach GC diagnostics', () => {
  assert.equal(fixtureTmuxGcSummary({ deadBinding: { candidate: false, reason: 'tmux_dead_process_pid_unknown' } })
    .deadBinding.reason, 'tmux_dead_process_pid_unknown');
  for (const operation of [null, 'broadcast', 'PRIVATE_OPERATION']) {
    const error = fixtureFailureError('PRIVATE_MESSAGE', {}, operation);
    error.tmuxGc = fixtureTmuxGcSummary({});
    assert.equal(fixtureFailureDiagnostic(error).tmuxGc, undefined);
  }
  const error = new Error('PRIVATE_MESSAGE');
  error.tmuxGc = fixtureTmuxGcSummary({});
  assert.equal(fixtureFailureDiagnostic(error).tmuxGc, undefined);
});
