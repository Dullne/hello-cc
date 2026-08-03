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

export function readClockGraceUntil(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'clock_grace_until'").get();
    if (!row) return 0;
    const value = Number.parseInt(row.value, 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    // meta table may not exist on hand-rolled test databases.
    return 0;
  }
}

export function writeClockGraceUntil(db, until) {
  try {
    db.prepare(`
      INSERT INTO meta(key, value) VALUES ('clock_grace_until', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(Number(until)));
  } catch {}
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
