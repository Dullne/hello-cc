// Exact, independently accepted releases. Do not admit an untested prerelease
// through a range or allow different core packages to share one Agent runtime.
export const DSH_BASELINE_VERSION = '0.2.0-rc.2';
export const DSH_SUPPORTED_VERSIONS = Object.freeze([DSH_BASELINE_VERSION, '0.2.1-rc.3']);
