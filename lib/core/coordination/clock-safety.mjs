const BACKWARD_TOLERANCE_SEC = 5;
const OPERATIONS = new Set(['ownership', 'gc']);
const EVIDENCE_STATES = new Set(['live', 'dead', 'unknown']);

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
