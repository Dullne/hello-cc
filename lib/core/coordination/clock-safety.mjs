import { tx } from '../../db/schema.mjs';
import { replaceCleanupFailureRoot } from '../../shared/cleanup-error.mjs';
import {
  CLOCK_GRACE_SEC,
  readClockGraceUntil,
  writeClockGraceUntil
} from '../../shared/clock-grace.mjs';
import { CliError } from '../../shared/errors.mjs';

const BACKWARD_TOLERANCE_SEC = 5;
// CS-01: a gap is only meaningful for a real wall-clock discontinuity. Ordinary
// forward progress between observations (the 30s reaper tick, on-demand lock
// ops) must NOT create or extend a gap — otherwise the merged window grows
// monotonically, every candidate boundary inside it re-crosses on every
// observation, unknown evidence opens a spurious grace window every 120s, and
// age-based GC is deferred forever. Steps larger than this threshold (a sleep,
// an NTP step, or a CLI invoked minutes apart) still produce a gap.
const FORWARD_GAP_THRESHOLD_SEC = 120;
const OPERATIONS = new Set(['ownership', 'gc']);
const EVIDENCE_STATES = new Set(['live', 'dead', 'unknown']);

export const CLOCK_SAFETY_PUBLIC_MESSAGE =
  'Clock safety state could not be persisted; ownership was left unchanged';

export function clockSafetyUnavailable(error) {
  const publicError = new CliError(
    'CLOCK_SAFETY_UNAVAILABLE',
    CLOCK_SAFETY_PUBLIC_MESSAGE
  );
  return replaceCleanupFailureRoot(error, publicError) || publicError;
}

function crossedBoundary(previous, current, boundary) {
  return previous < boundary && current >= boundary;
}

function requireTimestamp(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function validateCandidates(candidates) {
  if (!Array.isArray(candidates)) {
    throw new TypeError('candidates must be an array');
  }
  return candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new TypeError(`candidate ${index} must be an object`);
    }
    const boundary = requireTimestamp(candidate.boundary, `candidate ${index} boundary`);
    if (!EVIDENCE_STATES.has(candidate.evidence)) {
      throw new TypeError(`candidate ${index} evidence must be live, dead, or unknown`);
    }
    return { boundary, evidence: candidate.evidence };
  });
}

function validateGcCutoffs(gcCutoffs) {
  if (!Array.isArray(gcCutoffs)) {
    throw new TypeError('gcCutoffs must be an array');
  }
  return gcCutoffs.map((cutoff, index) => requireTimestamp(cutoff, `gcCutoff ${index}`));
}

export function decideClockSafety(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    throw new TypeError('clock observation must be an object');
  }

  const { previous, operation } = observation;
  const current = requireTimestamp(observation.current, 'current');
  if (!OPERATIONS.has(operation)) {
    throw new TypeError('operation must be ownership or gc');
  }
  const candidates = validateCandidates(
    observation.candidates === undefined ? [] : observation.candidates
  );
  const gcCutoffs = validateGcCutoffs(
    observation.gcCutoffs === undefined ? [] : observation.gcCutoffs
  );
  const firstObservation = previous === undefined;
  const previousSec = firstObservation ? undefined : requireTimestamp(previous, 'previous');

  const backward = !firstObservation
    && current < previousSec - BACKWARD_TOLERANCE_SEC;

  const hasUnknown = candidates.some(({ evidence }) => evidence === 'unknown');
  if (backward && (operation === 'gc' || hasUnknown)) {
    return { enterGrace: true, renewOwners: false, reason: 'clock-backward' };
  }

  const crossedCandidates = candidates.filter(({ boundary }) => firstObservation
    ? current >= boundary
    : crossedBoundary(previousSec, current, boundary));
  const renewOwners = crossedCandidates.some(({ evidence }) => evidence === 'live');

  if (crossedCandidates.some(({ evidence }) => evidence === 'unknown')) {
    return {
      enterGrace: true,
      renewOwners,
      reason: firstObservation ? 'first-observation' : 'unknown-evidence'
    };
  }

  if (operation === 'gc' && gcCutoffs.some((boundary) => (
    firstObservation ? current >= boundary : crossedBoundary(previousSec, current, boundary)
  ))) {
    return {
      enterGrace: true,
      renewOwners: false,
      reason: firstObservation ? 'first-observation' : 'gc-cutoff'
    };
  }

  if (renewOwners) {
    return { enterGrace: false, renewOwners: true, reason: 'verified-live' };
  }

  if (crossedCandidates.some(({ evidence }) => evidence === 'dead')) {
    return { enterGrace: false, renewOwners: false, reason: 'verified-dead' };
  }

  return { enterGrace: false, renewOwners: false, reason: 'no-boundary-crossing' };
}

function readObservedAt(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'clock_last_observed_at'").get();
  if (!row) return undefined;
  if (typeof row.value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.value)) {
    throw new Error('invalid persisted clock observation watermark');
  }
  const value = Number(row.value);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid persisted clock observation watermark');
  }
  return value;
}

function writeObservedAt(db, nowSec) {
  db.prepare(`
    INSERT INTO meta(key, value) VALUES ('clock_last_observed_at', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(nowSec));
}

function readPendingGap(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'clock_pending_gap'").get();
  if (!row) return null;
  let gap;
  try {
    gap = JSON.parse(row.value);
  } catch {
    throw new Error('invalid persisted pending clock gap');
  }
  if (!gap || typeof gap !== 'object' || Array.isArray(gap) ||
      !Number.isSafeInteger(gap.from) || gap.from < 0 ||
      !Number.isSafeInteger(gap.to) || gap.to < gap.from ||
      typeof gap.backward !== 'boolean' || typeof gap.first !== 'boolean') {
    throw new Error('invalid persisted pending clock gap');
  }
  return { from: gap.from, to: gap.to, backward: gap.backward, first: gap.first };
}

function writePendingGap(db, gap) {
  db.prepare(`
    INSERT INTO meta(key, value) VALUES ('clock_pending_gap', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify(gap));
}

function clearPendingGap(db) {
  db.prepare("DELETE FROM meta WHERE key = 'clock_pending_gap'").run();
}

function clockJumpSpanSec(clockJump) {
  const spanMs = Math.max(
    Number(clockJump?.wallDeltaMs || 0),
    Number(clockJump?.deltaMs || 0),
    Math.abs(Number(clockJump?.driftMs || 0))
  );
  return Number.isFinite(spanMs) ? Math.ceil(spanMs / 1000) : 0;
}

function nextObservationGap(previous, current, clockJump) {
  if (previous === undefined) {
    return { from: 0, to: current, backward: false, first: true };
  }
  if (clockJump?.kind === 'forward') {
    const spanSec = clockJumpSpanSec(clockJump);
    return {
      from: spanSec > 0 ? Math.max(0, current - spanSec) : 0,
      to: current,
      backward: false,
      first: false
    };
  }
  if (clockJump?.kind === 'backward' || current < previous - BACKWARD_TOLERANCE_SEC) {
    return {
      from: Math.min(previous, current),
      to: Math.max(previous, current),
      backward: true,
      first: false
    };
  }
  if (current > previous && current - previous > FORWARD_GAP_THRESHOLD_SEC) {
    return { from: previous, to: current, backward: false, first: false };
  }
  return null;
}

function mergePendingGap(persisted, observed) {
  if (!persisted) return observed;
  if (!observed) return persisted;
  return {
    from: Math.min(persisted.from, observed.from),
    to: Math.max(persisted.to, observed.to),
    backward: persisted.backward || observed.backward,
    first: persisted.first || observed.first
  };
}

function candidateCrossed(previous, current, candidate) {
  return previous === undefined
    ? current >= candidate.boundary
    : crossedBoundary(previous, current, candidate.boundary);
}

function clockSafetyPreviewState(db, {
  operation,
  candidates = [],
  gcCutoffs = [],
  nowSec,
  clockJump = null
} = {}) {
  requireTimestamp(nowSec, 'nowSec');
  if (clockJump !== null &&
      (!clockJump || typeof clockJump !== 'object' ||
       !['forward', 'backward'].includes(clockJump.kind))) {
    throw new TypeError('clockJump must be a forward or backward observation');
  }
  const previous = readObservedAt(db);
  const pendingGap = mergePendingGap(
    readPendingGap(db),
    nextObservationGap(previous, nowSec, clockJump)
  );
  const decisionCurrent = pendingGap?.backward ? nowSec : (pendingGap?.to ?? nowSec);
  const decisionPrevious = pendingGap?.backward
    ? decisionCurrent + BACKWARD_TOLERANCE_SEC + 1
    : pendingGap?.first
      ? undefined
      : pendingGap?.from ?? previous;
  let decision = decideClockSafety({
    previous: decisionPrevious,
    current: decisionCurrent,
    operation,
    candidates,
    gcCutoffs
  });
  const liveCandidateCrossed = (candidate) => pendingGap?.backward
    ? candidate.boundary <= nowSec
    : candidateCrossed(decisionPrevious, decisionCurrent, candidate);
  const renewableLiveCandidates = candidates.filter((candidate) =>
    candidate?.evidence === 'live' && liveCandidateCrossed(candidate));
  if (renewableLiveCandidates.length > 0 && !decision.renewOwners) {
    decision = {
      ...decision,
      renewOwners: true,
      reason: decision.reason === 'no-boundary-crossing' ? 'verified-live' : decision.reason
    };
  }
  let graceUntil = readClockGraceUntil(db);
  if (decision.enterGrace) graceUntil = Math.max(graceUntil, nowSec + CLOCK_GRACE_SEC);
  return { decision, graceUntil, pendingGap, renewableLiveCandidates };
}

export function previewClockSafety(db, options = {}) {
  const { decision, graceUntil } = clockSafetyPreviewState(db, options);
  return { decision, graceUntil };
}

export function observeClockSafetyInTransaction(db, options = {}) {
  if (!db?.isTransaction) {
    throw new Error('clock safety observation requires an active transaction');
  }
  const nowSec = options.nowSec;
  const {
    decision,
    graceUntil: previewGraceUntil,
    pendingGap,
    renewableLiveCandidates
  } = clockSafetyPreviewState(db, options);
  let graceUntil = readClockGraceUntil(db);
  if (decision.enterGrace) {
    graceUntil = writeClockGraceUntil(db, previewGraceUntil);
    clearPendingGap(db);
  } else if (pendingGap) {
    writePendingGap(db, pendingGap);
  }

  let renewed = 0;
  const liveOwners = new Set(renewableLiveCandidates
    .filter((candidate) => typeof candidate.owner === 'string' && candidate.owner)
    .map((candidate) => candidate.owner));
  if (liveOwners.size > 0) {
    const renew = db.prepare(`
      UPDATE locks
      SET expires_at = MAX(expires_at, ? + ttl_sec)
      WHERE owner = ?
    `);
    for (const owner of liveOwners) renewed += renew.run(nowSec, owner).changes;
  }

  writeObservedAt(db, nowSec);
  return { decision, graceUntil, renewed };
}

export function observeClockSafety(db, options = {}) {
  return tx(db, () => observeClockSafetyInTransaction(db, options));
}
