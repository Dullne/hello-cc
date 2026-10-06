import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureFailureError, fixtureFailureDiagnostic, fixtureDiagnosticText,
  fixturePeerListFormat, fixtureShimRegistrationSummary } from '../scripts/regression.mjs';

test('shim registration failure separates the failed text assertion from durable and live pane evidence', () => {
  const observation = {
    text: { format: 'runtime', peerPresent: false, tmuxPresent: true, panePresent: false }, providerEntered: true,
    persisted: { state: 'available', peerPresent: true, bindingPresent: true,
      transport: 'tmux', targetMatches: true, sessionMatches: true, peerStatus: 'working', processState: 'live' },
    pane: { state: 'found', dead: false, processState: 'live', command: 'bash' },
    events: ['tmux.session.attached', 'peer.start.requested']
  };
  const error = fixtureFailureError('PRIVATE_LIST_AND_MESSAGE', observation, 'shim-registration');
  const saved = fixtureFailureDiagnostic(error).shimRegistration;
  assert.deepEqual(saved, observation);
  observation.text.peerPresent = true;
  observation.pane.dead = true;
  observation.events.push('tmux.session.exited');
  assert.equal(saved.text.peerPresent, false);
  assert.equal(saved.pane.dead, false);
  assert.deepEqual(saved.events, ['tmux.session.attached', 'peer.start.requested']);
  for (const part of [saved, saved.text, saved.persisted, saved.pane, saved.events]) assert.ok(Object.isFrozen(part));
  assert.doesNotMatch(fixtureDiagnosticText(fixtureFailureDiagnostic(error)), /PRIVATE_|MESSAGE|LIST/);
});

test('shim registration diagnostics reject arbitrary strings, fields and wrongly typed observations', () => {
  const saved = fixtureShimRegistrationSummary({
    peer: 'PRIVATE_PEER', output: 'PRIVATE_OUTPUT', env: { TOKEN: 'PRIVATE_SECRET' }, providerEntered: 'true',
    text: { peerPresent: 'true', tmuxPresent: 1, panePresent: null, raw: 'PRIVATE_TABLE' },
    persisted: { state: 'PRIVATE_STATE', peerPresent: [], bindingPresent: {}, transport: 'PRIVATE_TRANSPORT',
      targetMatches: 1, sessionMatches: 'yes', peerStatus: 'PRIVATE_STATUS', processState: 'PRIVATE_PROCESS',
      root: 'PRIVATE_ROOT' },
    pane: { state: 'PRIVATE_PANE', dead: 'false', processState: 'PRIVATE_PROCESS', command: 'PRIVATE_COMMAND' },
    events: ['PRIVATE_EVENT', ...Array(30).fill('tmux.session.attached')]
  });
  assert.deepEqual(saved.text, { format: 'unknown', peerPresent: null, tmuxPresent: null, panePresent: null });
  assert.equal(saved.providerEntered, null);
  assert.equal(saved.persisted.transport, 'unknown');
  assert.equal(saved.pane.command, 'unknown');
  assert.equal(saved.events.length, 8);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_|TOKEN|SECRET|output|root/);
});

test('only the explicit shim fixture failure operation can publish its sealed registration diagnostic', () => {
  const observation = { pane: { state: 'not-found' }, providerEntered: false,
    persisted: { state: 'unavailable' }, events: ['tmux.session.exited'] };
  const owned = fixtureFailureError('PRIVATE_MESSAGE', observation, 'shim-registration');
  assert.equal(fixtureFailureDiagnostic(owned).shimRegistration.pane.state, 'not-found');
  assert.equal(fixtureFailureDiagnostic(owned).shimRegistration.providerEntered, false);
  const forged = new Error('PRIVATE_MESSAGE');
  forged.shimRegistration = fixtureFailureDiagnostic(owned).shimRegistration;
  assert.equal(fixtureFailureDiagnostic(forged).shimRegistration, undefined);
  for (const operation of [null, 'PRIVATE_OPERATION', 'broadcast']) {
    const error = fixtureFailureError('PRIVATE_MESSAGE', observation, operation);
    error.shimRegistration = forged.shimRegistration;
    assert.equal(fixtureFailureDiagnostic(error).shimRegistration, undefined);
  }
});

test('shim diagnostics preserve production starting and running peer states', () => {
  for (const peerStatus of ['starting', 'running']) {
    assert.equal(fixtureShimRegistrationSummary({ persisted: { peerStatus } }).persisted.peerStatus, peerStatus);
  }
});

test('peer list diagnostics distinguish runtime rows from the CLI database fallback by exact headers', () => {
  assert.equal(fixturePeerListFormat('id  peer  kind  role  status  type  pane  provider  resume  session  pid  command\nPRIVATE_RUNTIME'), 'runtime');
  assert.equal(fixturePeerListFormat('id  kind  role  status  age  active  branch\nPRIVATE_DATABASE'), 'database');
  for (const text of [undefined, '', '(none)', 'id kind PRIVATE_FIELD', 'PRIVATE_PREFIX\nid kind role status age active branch']) {
    assert.equal(fixturePeerListFormat(text), 'unknown');
  }
  const diagnostic = fixtureShimRegistrationSummary({ text: { format: 'PRIVATE_FORMAT' } });
  assert.equal(diagnostic.text.format, 'unknown');
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_/);
});
