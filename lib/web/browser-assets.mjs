import { fileURLToPath } from 'node:url';

// Explicit public module graph. Never resolve a request path against lib/.
const names = [
  'browser/core.mjs', 'browser/project-data.mjs', 'browser/session-sync.mjs',
  'api-version.mjs', 'ui-agent-start.mjs', 'ui-command-palette.mjs', 'ui-files.mjs',
  'ui-codex.mjs', 'ui-codex-account.mjs', 'ui-handoff.mjs', 'ui-history.mjs',
  'ui-interactions.mjs', 'ui-i18n.mjs', 'ui-native.mjs', 'ui-native-timeline.mjs',
  'ui-preferences.mjs', 'ui-review.mjs', 'ui-safe-markdown.mjs',
  'ui-session-tools.mjs', 'ui-terminal-find.mjs', 'ui-workbench.mjs', 'ui-workspace.mjs'
];
const assets = new Map(names.map(name => ['/assets/web/' + name, fileURLToPath(new URL(name, import.meta.url))]));
// These shared validators are pure JavaScript and imported by the interaction
// panel. Keep the two integration paths explicit; other integrations stay private.
for (const name of ['mcp-elicitation.mjs', 'mcp-url-elicitation.mjs']) {
  assets.set('/assets/integrations/' + name, fileURLToPath(new URL('../integrations/' + name, import.meta.url)));
}
export function browserAssetPath(pathname) { return assets.get(pathname) || null; }
export const BROWSER_ASSET_PATHS = Object.freeze([...assets.keys()]);
