# ADR 0033: Bundle Inter for offline builds

- Date: 2026-09-13
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

The network-isolated Cloudflare compatibility build cannot download Inter through
`next/font/google`. The shared web layout and default Tailwind family consume
this font, so resolving the dependency affects shared typography, not just the
local Docker probe. Hiro approved proceeding after that scope was explained.

## Decision

Bundle an unmodified, pinned upstream Inter variable font with its copyright,
license and checksum. Use the existing `next/font/local` integration while
preserving the `inter` export, `--font-inter`, normal variable weights and swap
loading. Leave Satoshi, Geist Mono, application APIs and data contracts unchanged.
Verify generated metrics and representative EN/JA/VI rendering; do not assume
the upstream release is byte-identical to Google's distribution.

## Alternatives considered

- **Allow font downloads during each build** — rejected: preserves an external
  build dependency and requires changing the isolated build's network boundary.
- **Replace Inter with another font** — rejected: unnecessary visual redesign.
- **Mock font downloads** — rejected: would not establish real asset packaging.

## Consequences

### Positive

- Removes the Google font download prerequisite without introducing a dependency.
- Asset version and license become auditable and reproducible.

### Negative / trade-offs accepted

- Adds a font binary and license to the repository; upgrades become explicit.
- Shared typography needs regression checks, including fallback metrics.

### Follow-ups

- Verify asset provenance, offline build, resource limits and rendered output.
- Keep full runtime/public-app/live acceptance gates open until independently met.

## References

- Hiro's instruction to proceed in this task after the shared-font approval request.
- [Inter upstream](https://github.com/rsms/inter)
- [Local compatibility ADR](0032-local-cloudflare-containers-compatibility.md)
