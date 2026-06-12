# Changelog

This project keeps one changelog file. Add one section per release, with the
newest version first. Do not create a new changelog file for every release.

Before publishing, run:

```bash
npm run release:check
npm run release:notes
```

Use the output of `npm run release:notes` as the GitHub Release description for
the current `package.json` version.

## 0.1.2

### Summary

hello-cc 0.1.2 tightens the public release surface after the first scoped npm
publish. It adds a first-class update command, makes uninstall discoverable in
top-level help, and reorganizes the documentation so the npm package page and
GitHub release notes have a clear, detailed description of what changed.

### Highlights

- Added `hcc update`, which updates the global npm install by running
  `npm install -g @logicseek/hello-cc@latest`.
- Added `hcc update --tag`, `hcc update --registry`, and `hcc update --dry-run`
  for controlled upgrades and release verification.
- Made `hcc uninstall` visible in top-level `hcc --help`, matching the README
  and command reference.
- Kept uninstall behavior conservative: `hcc uninstall` removes hooks and
  shims, while `hcc uninstall --purge --yes` is required to remove project data.
- Split documentation into a short README, a user guide, command reference, and
  documentation index in both English and Chinese.
- Restored the Star History chart at the bottom of both README files.
- Included README-linked package assets in the npm tarball so the package page
  renders the project logo correctly.

### Documentation

- `README.md` and `README.zh-CN.md` now focus on product positioning, install
  and maintenance commands, quick start, a basic workflow, and links to docs.
- `docs/guide.md` and `docs/guide.zh-CN.md` describe practical usage and avoid
  embedding the full command list.
- `docs/commands.md` and `docs/commands.zh-CN.md` provide the compact command
  reference.
- `docs/README.md` and `docs/README.zh-CN.md` provide the documentation index.
- English documentation links now point to English user docs, and Chinese
  documentation links point to Chinese user docs.

### Validation

The 0.1.2 release should be validated with:

```bash
git diff --check
node --check bin/hcc.mjs
node --check scripts/regression.mjs
node --check lib/setup.mjs
node --check lib/discover.mjs
npm pack --dry-run --json
npm publish --dry-run --registry=https://registry.npmjs.org/ --access public
npm test
```

The package dry run should include `CHANGELOG.md`, `assets/logo.svg`, and the
English and Chinese command reference files.

The expected full regression marker is:

```text
FULL_REGRESSION_OK
```

### Release Notes Source

Use this changelog section as the source for the GitHub Release notes for
`v0.1.2`. The npm package metadata keeps a short description, while the package
README and this changelog provide the detailed release description.
