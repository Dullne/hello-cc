import { CliError } from '../../shared/errors.mjs';

export const NATIVE_PROVIDERS = Object.freeze(['codex', 'claude', 'dsh']);

export async function createNativeAdapter(provider, options) {
  if (provider === 'codex') return (await import('./codex.mjs')).createCodexAdapter(options);
  if (provider === 'claude') return (await import('./claude.mjs')).createClaudeAdapter(options);
  if (provider === 'dsh') return (await import('./dsh-acp.mjs')).createDshAcpAdapter(options);
  throw new CliError('BAD_ARGS', `Unsupported native provider: ${provider}`);
}

export function nativeWorkerEnv(env, ctx, peer, owner) {
  const clean = Object.fromEntries(Object.entries(env || {}).filter(([key]) =>
    !key.startsWith('HCC_') && !key.startsWith('CLAUDE_CODE_') &&
    !['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDECODE'].includes(key)));
  // Explicit, worker-specific coordination identity; provider credentials and
  // the real HOME are preserved. No global configuration is rewritten.
  return { ...clean, HCC_ROOT: ctx.root, HCC_DB: ctx.dbPath, HCC_PEER: peer, ...(owner ? { HCC_NATIVE_OWNER: owner } : {}) };
}
