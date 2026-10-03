export function normalizeVersion(version) {
  return String(version || '').replace(/^v/, '');
}

export function isPrereleaseVersion(version) {
  const numeric = '(?:0|[1-9][0-9]*)';
  const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
  const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
  const match = normalizeVersion(version).match(semver);
  if (!match) throw new Error(`Invalid release version: ${version}`);
  return match[1] !== undefined;
}

export function releaseSection(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  const heading = `## ${version}`;
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

export function validateReleaseSection(section, version) {
  const problems = [];
  if (!section) {
    problems.push(`CHANGELOG.md is missing section ## ${version}`);
    return problems;
  }
  if (!section.includes('### Summary')) problems.push(`## ${version} is missing ### Summary`);
  if (!section.includes('### Highlights')) problems.push(`## ${version} is missing ### Highlights`);
  if (section.includes('TODO') || section.includes('TBD')) problems.push(`## ${version} still contains TODO/TBD text`);
  const bulletCount = (section.match(/^- /gm) || []).length;
  if (bulletCount < 2) problems.push(`## ${version} should include at least two release-note bullets`);
  return problems;
}

export function repoFromPackage(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!repo) return null;
  const match = repo.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/);
  return match ? match[1] : null;
}
