import assert from 'node:assert/strict';
import test from 'node:test';
import { stabilityOptions, assertStabilityEvidence, stabilityPayload, assertSoakEvidence } from '../scripts/native-stability-checks.mjs';

test('opt-in stability arguments bound model load and reject missing or contradictory settings', () => {
  assert.equal(stabilityOptions([]), null);
  assert.deepEqual(stabilityOptions(['--stability']), { cycles: 6, burst: 2, idleMs: 30000, resumeEvery: 2, soakSeconds: 0 });
  assert.deepEqual(stabilityOptions(['--stability', '--stability-cycles', '8', '--stability-burst', '3', '--stability-idle-ms', '0', '--stability-resume-every', '4']),
    { cycles: 8, burst: 3, idleMs: 0, resumeEvery: 4, soakSeconds: 0 });
  for (const args of [
    ['--stability-cycles', '2'],
    ['--stability-soak-seconds', '86400'],
    ['--stability', '--stability-soak-seconds', '86401'],
    ['--stability', '--stability-cycles', '1', '--stability-soak-seconds', '1'],
    ['--stability-only'],
    ['--stability', '--stability-cycles'],
    ['--stability', '--stability-cycles', '--output'],
    ['--stability', '--stability-cycles', '0'],
    ['--stability', '--stability-cycles', '25'],
    ['--stability', '--stability-burst', '5'],
    ['--stability', '--stability-idle-ms', '-1'],
    ['--stability', '--stability-idle-ms', '300001'],
    ['--stability', '--stability-cycles', '1.5'],
    ['--stability', '--stability-resume-every', '0'],
    ['--stability', '--stability-cycles', '2', '--stability-cycles', '3']
  ]) assert.throws(() => stabilityOptions(args), { code: 'ERR_ASSERTION' });
});

test('a 24-hour soak requires elapsed time, every workload cycle, recovery and a final model probe', () => {
  const valid = { targetSeconds: 86400, elapsedMs: 86400001, completedCycles: 6, expectedCycles: 6, recovered: true, finalProbePassed: true };
  assertSoakEvidence(valid);
  for (const change of [{ elapsedMs: 86399999 }, { completedCycles: 5 }, { expectedCycles: 1, completedCycles: 1 },
    { recovered: false }, { finalProbePassed: false }, { targetSeconds: 0 }, { elapsedMs: NaN }]) {
    assert.throws(() => assertSoakEvidence({ ...valid, ...change }), { code: 'ERR_ASSERTION' });
  }
  assert.equal(stabilityOptions(['--stability', '--stability-soak-seconds', '86400']).soakSeconds, 86400);
});

test('stability acceptance rejects duplicate replies, premature ACKs and lost or reordered context', () => {
  const marker = 'HCC_STABILITY_CODEX_abcdef0123456789';
  const payload = `${marker}|T1_0_abcdef01|SEED`;
  const valid = { state: 'completed', replyCount: 1, ackCount: 1, replyThread: 7, messageId: 7,
    expected: payload, actual: payload };
  assertStabilityEvidence(valid);
  for (const changed of [
    { state: 'uncertain' }, { state: 'failed' }, { replyCount: 0 }, { replyCount: 2 }, { ackCount: 0 },
    { ackCount: 2 }, { replyThread: 8 }, { actual: `${marker}|T1_0_abcdef01|T1_1_aaaaaaaa` }, { actual: payload.replace('abcdef0123456789','0000000000000000') },
    { actual: 'no remembered context' }, { actual: `${payload}\n${payload}` }
  ]) assert.throws(() => assertStabilityEvidence({ ...valid, ...changed }), { code: 'ERR_ASSERTION' });
});

test('stability checks preserve full model prose while requiring one correct unambiguous context tuple', () => {
  const expected = 'HCC_STABILITY_CLAUDE_0123456789abcdef|T2_0_aaaaaaaa|SEED';
  const actual = `${expected}\n\nRemembered: previous stability ticket is now T2_0_aaaaaaaa.`;
  assert.equal(stabilityPayload(actual), expected);
  assertStabilityEvidence({ state: 'completed', replyCount: 1, ackCount: 1, replyThread: 9, messageId: 9, expected, actual });
  assert.throws(() => stabilityPayload(expected + '\nHCC_STABILITY_CLAUDE_0123456789abcdef|T2_0_aaaaaaaa|T1_0_bbbbbbbb'));
});
