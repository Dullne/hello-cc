// Wall-clock jump protection (hb-05). All age/TTL comparisons use wall-clock
// seconds (last_seen_at / expires_at are persisted across processes), so a
// forward jump (macOS sleep, NTP step) makes every peer look stale and every
// lock look expired at once. The long-lived web runtime detects the jump and
// persists a grace deadline in the DB meta table; every process (runtime and
// short-lived CLIs, which share the same system clock) then suppresses
// age-based decisions until the grace window passes. This is deliberately
// conservative: keeping a truly-dead peer alive for one grace window is safe;
// reaping/taking-over a live peer is not.

export const CLOCK_GRACE_SEC = 120;

function parsePersistedDeadline(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('invalid persisted deadline for clock grace');
  }
  const persisted = Number(value);
  if (!Number.isSafeInteger(persisted) || persisted < 0) {
    throw new Error('invalid persisted deadline for clock grace');
  }
  return persisted;
}

export function readClockGraceUntil(db) {
  let row;
  try {
    row = db.prepare("SELECT value FROM meta WHERE key = 'clock_grace_until'").get();
  } catch {
    // meta table may not exist on hand-rolled test databases.
    return 0;
  }
  return row ? parsePersistedDeadline(row.value) : 0;
}

export function writeClockGraceUntil(db, until) {
  if (typeof until !== 'number' || !Number.isSafeInteger(until) || until < 0) {
    throw new TypeError('clock grace deadline must be a non-negative safe integer');
  }

  const row = db.prepare(`
    INSERT INTO meta(key, value) VALUES ('clock_grace_until', ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(
      MAX(CAST(meta.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT
    )
    WHERE (meta.value = '0' OR (
        meta.value GLOB '[1-9]*'
        AND meta.value NOT GLOB '*[^0-9]*'
      ))
      AND CAST(meta.value AS INTEGER) BETWEEN 0 AND 9007199254740991
    RETURNING value AS deadline
  `).get(String(until));

  if (!row) {
    throw new Error('invalid persisted deadline for clock grace');
  }
  return parsePersistedDeadline(row.deadline);
}

// True while the grace window is active at wall-clock second `nowSec`.
export function clockGraceSuppressed(nowSec, graceUntil) {
  return Number(graceUntil) > Number(nowSec);
}

// Classify a wall-clock probe delta (ms between two ticks of a known-interval
// poller). Returns null when the delta is normal, or { kind } for a forward
// jump (sleep / NTP step forward) or backward jump (NTP step back).
export function classifyClockJump(deltaMs, { tickMs = 30000, forwardFactor = 3, backwardMs = 5000 } = {}) {
  if (deltaMs > tickMs * forwardFactor) return { kind: 'forward', deltaMs };
  if (deltaMs < -backwardMs) return { kind: 'backward', deltaMs };
  return null;
}
