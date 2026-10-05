import assert from 'node:assert/strict';

const observedAtKey = 'clock_last_observed_at';

function timestamp(value, label) {
  assert.ok(Number.isSafeInteger(value) && value >= 0, `${label} must be a nonnegative safe integer`);
  return value;
}

function observedAt(rows, label) {
  const matches = rows.filter(row => row.key === observedAtKey);
  assert.equal(matches.length, 1, `${label} must contain exactly one clock observation`);
  assert.match(matches[0].value, /^(0|[1-9]\d*)$/, `${label} clock observation must be a canonical timestamp`);
  return timestamp(Number(matches[0].value), `${label} clock observation`);
}

// An active runtime observes its clock even when its reaper has no candidates.
// Only that watermark may advance while the manual GC preview is in flight.
export function assertGcPreviewMetadata(before, after, { startedAtSec, finishedAtSec }) {
  timestamp(startedAtSec, 'preview start');
  timestamp(finishedAtSec, 'preview finish');
  assert.ok(finishedAtSec >= startedAtSec, 'preview time window must be monotonic');
  assert.deepEqual(
    after.filter(row => row.key !== observedAtKey),
    before.filter(row => row.key !== observedAtKey),
    'manual GC preview changed metadata other than the runtime clock observation'
  );
  const previous = observedAt(before, 'before preview');
  const current = observedAt(after, 'after preview');
  assert.ok(previous >= startedAtSec && previous <= finishedAtSec, 'initial clock observation is outside the preview time window');
  assert.ok(current >= previous, 'runtime clock observation moved backward during the preview');
  assert.ok(current <= finishedAtSec, 'runtime clock observation is beyond the preview time window');
}
