# hello-cc Documentation

Start with the [project README](../README.md) when you only need the project
summary and first command. Use these docs when you need more detail.

## User Docs

- [User Guide](guide.md): install, start, Web console, coordination semantics,
  workflow, stable peer identity, and environment behavior.
- [Command Reference](commands.md): compact list of public commands and the
  intended use of each command group.
- [Changelog](../CHANGELOG.md): release notes for published versions.
- Release notes: run `npm run release:check` before publishing, and use
  `npm run release:notes` to print the current changelog section for GitHub
  Release notes.

## Design And Implementation

- [Design Notes](design.md): product boundary, project boundary, capability
  levels, coordination semantics, and provider-session binding.
- [Implementation Notes](implementation.md): architecture, protocol, command
  surface, stack, shim behavior, and implementation plan.
