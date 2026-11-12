#!/usr/bin/env node
// Environment diagnosis must remain available without SQLite/project state.
import { environmentCommandArguments, runEnvironmentEntry } from '../lib/cli/environment-entry.mjs';

const environmentArgs = environmentCommandArguments(process.argv.slice(2));
if (environmentArgs) runEnvironmentEntry(environmentArgs);
else {
  const { runCli } = await import('../lib/cli/app.mjs');
  await runCli();
}
