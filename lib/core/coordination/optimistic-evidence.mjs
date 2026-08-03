import { tx } from '../../db/schema.mjs';
import { CliError } from '../../shared/errors.mjs';

export function runOptimisticEvidenceMutation(db, options = {}) {
  const attempts = Number(options.attempts || 2);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const subject = options.capture(db);
    const evidence = options.observe(subject);
    let subjectChanged = false;
    const result = tx(db, () => {
      const current = options.capture(db);
      if (!options.same(subject, current)) {
        subjectChanged = true;
        return null;
      }
      return options.mutate(current, evidence);
    });
    if (!subjectChanged) return result;
  }
  throw new CliError('SUBJECT_CHANGED', options.changedMessage || 'Coordination subject changed while evidence was being observed; retry', {
    retryable: true
  });
}
