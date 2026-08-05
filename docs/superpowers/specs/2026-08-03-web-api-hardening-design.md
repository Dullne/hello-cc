# Web and Runtime API v2 Hardening Design

Status: approved in conversation on 2026-08-03.

## Purpose

Define the v1 Web authentication, Runtime API v2, browser policy, path safety,
and log-redaction contract while preserving two explicitly accepted risks.

## Accepted Risks

- The default Web listener remains `0.0.0.0` over HTTP for LAN access.
- An authenticated administrator may select any existing server project root.

These choices permit passive LAN observation of HTTP traffic and broad access
to server project directories by anyone holding the administrator credential.
Documentation must state these risks and must not mark transport confidentiality
or project scoping as fully remediated.

## Authentication Roles

The stable runtime token is the administrator credential. An HttpOnly browser
cookie issued after successful token login represents the same administrator
role. Both may create, stop, attach, and inject managed sessions.

A session action token is narrower. It authorizes terminal WebSocket input for
one managed session and is delivered only in that session's terminal snapshot.
It is never returned by the session list. Session action token comparisons use
the shared constant-time token helper.

Cookie sessions have a server-side expiry, a bounded count, explicit logout,
and tracked WebSocket membership. Expiry, eviction, or logout closes associated
WebSockets immediately. Cookie-authenticated mutations require a same-origin
request.

Non-loopback listeners require a non-empty administrator token. Tokenless mode
is accepted only from a loopback socket.

## Runtime API v2

Runtime metadata advertises API version 2. CLI and browser HTTP requests send
`X-HCC-API-Version: 2`. Browser WebSocket handshakes send `api_version=2` in the
query because the WebSocket browser API cannot set an arbitrary request header.
Protected API requests with a missing or unsupported version receive HTTP 426
with `API_VERSION_UNSUPPORTED` and the supported version.

Public login and static bootstrap routes remain reachable without the API
version header. The v1 release notes identify removal of `action_token` from
`GET /api/sessions` as a breaking API change.

## Browser Policy

HTML responses use a per-response nonce. The Content Security Policy permits
scripts only from self and the response nonce, denies objects and framing,
restricts base URIs, and permits only the same-origin HTTP/WebSocket connections
needed by the console. Styles allow the current xterm and inline-style contract;
script policy must not require `unsafe-inline`.

Responses retain no-store, no-referrer, and nosniff headers. Secure requests may
add transport-only headers without applying HSTS to accepted plaintext mode.

## Path Safety

Arbitrary existing roots remain supported, but lexical containment is not
enough. The selected root is canonicalized with `realpath`. The `.hello-cc`
directory is created with owner-only permissions when absent and canonicalized
when present. A symlinked `.hello-cc` or DB parent that resolves outside the
canonical state directory is rejected.

The selected database must resolve to `mesh.db` or another path below the real
`.hello-cc` directory. Pseudo-files, non-regular database targets, and symlink
escapes are rejected before SQLite opens the target.

## TLS and Proxy Modes

Direct `--tls` mode validates certificate dates, SAN coverage, key pairing, file
permissions, and generation publication before listening. CLI requests trust
only the runtime's stored self-signed certificate.

`--trust-proxy --proxy-origin https://host[:port]` accepts forwarded host/proto
only from a loopback peer and only when both exactly match the pinned public
origin. Either option without the other is rejected. Forwarded headers from any
non-loopback peer are ignored. Cookie `Secure` state and origin checks consume
the same trusted-proxy decision.

## Secret Redaction

All startup and error logging passes through one redactor. It removes or replaces
values for `--token`, Authorization, cookies, session action tokens, runtime
tokens, and URL `token` query parameters. The redactor handles both structured
objects and command-line strings. Runtime pointer files remain owner-readable
only because local CLI operation requires the administrator token.

## Acceptance Criteria

- Old or missing API versions receive 426 on protected API routes.
- Admin token and admin cookie retain documented management behavior.
- Session action tokens are absent from lists and required for WS input.
- Logout and expiry close existing cookie-authenticated WebSockets.
- CSP blocks an injected inline script without the nonce.
- Logs contain no supplied administrator, cookie, or session token value.
- Symlink DB escape is rejected while a normal arbitrary project root works.
- Direct TLS, loopback trusted proxy, and accepted plaintext LAN modes pass
  independent integration tests.
