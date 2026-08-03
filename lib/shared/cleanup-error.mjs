const CLEANUP_FAILURE = Symbol('cleanup-failure');

export function aggregateCleanupFailure(
  primaryError,
  cleanupError,
  message,
  cleanup = {}
) {
  const error = new AggregateError(
    [primaryError, cleanupError],
    message,
    { cause: primaryError }
  );
  error[CLEANUP_FAILURE] = true;
  error.cleanup = Object.freeze({ ...cleanup });
  return error;
}

export function cleanupFailureRoot(error) {
  let current = error;
  let foundCleanup = false;
  const seen = new Set();
  while (current instanceof AggregateError && current[CLEANUP_FAILURE] === true) {
    if (seen.has(current) || current.errors?.[0] !== current.cause) return null;
    seen.add(current);
    foundCleanup = true;
    current = current.cause;
  }
  return foundCleanup ? current : null;
}

export function replaceCleanupFailureRoot(error, replacement) {
  const seen = new Set();
  function rebuild(current) {
    if (!(current instanceof AggregateError) || current[CLEANUP_FAILURE] !== true) {
      return replacement;
    }
    if (seen.has(current) || current.errors?.length !== 2 || current.errors[0] !== current.cause) {
      return null;
    }
    seen.add(current);
    const primaryError = rebuild(current.cause);
    if (primaryError === null) return null;
    return aggregateCleanupFailure(
      primaryError,
      current.errors[1],
      current.message,
      current.cleanup
    );
  }

  if (!(error instanceof AggregateError) || error[CLEANUP_FAILURE] !== true) return null;
  return rebuild(error);
}
