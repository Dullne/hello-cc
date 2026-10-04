# Initial 1.0.5 identity candidate

This archive preserves the exact package and manifest for source commit
`e56faf72ac7d3d165ce88f362f6c6f8a39d9d62c` (SHA256
`c1c4bc5123c72c4e8fd59c965cbb299bdab9e03a533962ef3ac2ca3927d97a83`).
It passed the current-Mac 30-minute synthetic coordination run. Its mainline
macOS regression failed during runtime shutdown; subsequent diagnosis captured
an unreachable stop response followed by original-owner exit.

This candidate was not published. The active release manifest one directory
above belongs to the later stop-confirmation candidate and must be evaluated
separately. The original run does not validate the later tarball bytes.
