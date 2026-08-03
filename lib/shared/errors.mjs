import { cleanupFailureRoot } from './cleanup-error.mjs';

export class CliError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

export function publicCliFailure(error) {
  if (error instanceof CliError) return { error, cleanupFailed: false };
  const rootError = cleanupFailureRoot(error);
  if (rootError instanceof CliError) return { error: rootError, cleanupFailed: true };
  return null;
}
