import assert from 'node:assert/strict';

// Explicit limits bound opt-in model consumption and idle observation time.
export function stabilityOptions(args) {
  const fields = [
    ['--stability-cycles', 'cycles', 6, 1, 24],
    ['--stability-burst', 'burst', 2, 1, 4],
    ['--stability-idle-ms', 'idleMs', 30000, 0, 300000],
    ['--stability-resume-every', 'resumeEvery', 2, 1, 24]
  ];
  const enabled = args.includes('--stability');
  assert.ok(!args.includes('--stability-only') || enabled, '--stability-only requires --stability');
  const config = {};
  for (const [flag, key, fallback, min, max] of fields) {
    const indices = args.flatMap((value, index) => value === flag ? [index] : []);
    assert.ok(indices.length <= 1, `${flag} must not be repeated`);
    assert.ok(enabled || !indices.length, `${flag} requires --stability`);
    const raw = indices.length ? args[indices[0] + 1] : String(fallback);
    assert.ok(typeof raw === 'string' && /^\d+$/.test(raw), `${flag} requires an integer`);
    const value = Number(raw);
    assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, `${flag} must be ${min}..${max}`);
    config[key] = value;
  }
  return enabled ? config : null;
}

export function stabilityPayload(text) {
  assert.equal(typeof text, 'string');
  const tuples = text.match(/\bHCC_STABILITY_(?:CODEX|CLAUDE|DSH)_[0-9a-f]{16}\|(?:SEED|T\d+_\d+_[0-9a-f]{8})(?:\|(?:SEED|T\d+_\d+_[0-9a-f]{8}))?/g) || [];
  assert.equal(tuples.length, 1, 'reply must contain one unambiguous stability tuple');
  return tuples[0];
}

export function assertStabilityEvidence(evidence) {
  assert.equal(evidence.state, 'completed', 'stability work must complete');
  assert.equal(evidence.replyCount, 1, 'stability work must have exactly one reply');
  assert.equal(evidence.ackCount, 1, 'stability work must have exactly one ACK');
  assert.equal(evidence.replyThread, evidence.messageId, 'reply must retain its request thread');
  assert.equal(stabilityPayload(evidence.actual), evidence.expected, 'original context and FIFO predecessor must match');
}
