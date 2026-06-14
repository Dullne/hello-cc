/**
 * Compatibility entrypoint for zero-config Claude Code / Codex integration.
 */
export {
  installClaudeHooks,
  installCodexHooks,
  uninstallClaudeHooks,
  uninstallCodexHooks,
  verifyClaudeHooks,
  verifyCodexHooks
} from './integrations/hooks.mjs';
export {
  findRealBinary,
  installShims,
  SHIM_DIR,
  uninstallShims,
  verifyShims
} from './integrations/shims.mjs';
export { installPathEntry, uninstallPathEntry } from './shell-path.mjs';
