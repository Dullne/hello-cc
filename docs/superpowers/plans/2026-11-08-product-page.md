# hello-cc product page

**Goal:** Add a Chinese, light-themed promotional page grounded in the current README and Web workbench capabilities.

**Design:** White canvas, dark ink, emerald brand accent, generous spacing. A large two-line headline leads into an interactive, explicitly labeled workflow illustration. Follow with provider support, three coordination steps, capability rows, an actual console screenshot viewer, and installation commands. Reuse the repository logo and screenshot. No invented adoption numbers or performance claims. Image generation is unavailable in this session; use native HTML/CSS for the workflow and existing project assets.

**Architecture:** Dependency-free static HTML/CSS/ES module in `assets/site/`, served from public `/welcome` by a strict asset allowlist. Preserve `/`, cookie exchange, Host checks and all API authentication. A standalone loopback preview server serves the same files without starting HCC or touching project state. No external fonts, tracking, API requests or live worker actions.

**Content boundaries:** Linux/macOS; Windows via WSL. Node.js >=24 and tmux for HCC. Provider setup is separate. Locks are advisory. Desktop applications keep their own executors. Demo values are illustrative. The page itself may be previewed independently of the runtime.

## Implementation and verification

- [x] Add route regression tests for guest access, allowlisted assets, HEAD/method behavior, authentication and no project access.
- [x] Implement page, responsive navigation, keyboard-operable workflow tabs, copy feedback/fallback, screenshot dialog and reduced motion.
- [x] Connect `/welcome`, add standalone preview command and document both entry points.
- [x] Run focused route/security tests, static identifier audit, package asset check and actual browser checks.
- [x] Inspect desktop/mobile screenshots, check overflow at 320/390/768/1440 pixels, keyboard interactions, console errors and no API requests.

Browser plugin is unavailable; use the existing Playwright development dependency. Preserve all unrelated files. Do not start agents, tmux, WSL or the production runtime for this task.

## Visual review and validation

- Copy: checked headline, navigation, CTA labels and provider names against the intended content and current README. Demo information is explicitly labeled. Fixed source links to use the actual `master` branch.
- Layout: inspected rendered desktop and mobile screenshots; three-column workbench simplifies to the central panel on phones. No horizontal overflow at 320, 390, 768, 1024 or 1440 pixels.
- Typography: consistent explicit sizes for controls and headings; preserved installation newlines with semantic `pre` markup. Windows clipboard checks normalize CRLF for comparison.
- Palette: white canvas, emerald accent, pale green section backgrounds; darkened auxiliary text to meet contrast checks. Axe WCAG A/AA checks passed on three tab states and screenshot dialog at 1440, 390 and 320 pixels.
- Assets: existing brand SVG and actual README console screenshot load locally. Screenshot dialog supports Escape and restores focus. No generated concept comparison was possible because image generation was unavailable.
- Interaction: 93 browser assertions passed using Playwright with installed Edge; menu, tabs, keyboard, copy success/failure, dialog, reduced motion and no-JavaScript content checked. No console errors or API/external requests.
- Routing: 19 focused route/authentication/asset regression tests passed. Changed routing modules pass the identifier audit; package dry-run includes all required page assets.

Existing repository limitations: full identifier audit reports 15 unchanged modules. An expanded API-version test hits the existing POSIX-only private-state boundary on native Windows. The host has Node 22; no full Node 24/Linux/macOS/tmux or real-agent runtime acceptance is claimed.
