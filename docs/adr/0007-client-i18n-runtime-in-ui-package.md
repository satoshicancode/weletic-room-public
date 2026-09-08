# ADR 0007: Client i18n runtime in UI package

- Date: 2026-08-16
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Weletic's English, Vietnamese, and Japanese interface support introduced a React
internationalization provider, hooks, locale dictionaries, and locale metadata
under `packages/utils/src/i18n`. The root `@dub/utils` barrel re-exported that
module. This mixed a browser-only React runtime with a utility package consumed
by approximately 1,484 web application files, including API routes, server
actions, instrumentation, and other server-only modules.

The utility package is built with tsup. Its shared chunk containing
`createContext`, `useEffect`, and `useState` did not preserve the source
`"use client"` boundary. Consequently, Next.js treated the chunk as server code
and rejected every server graph that reached the root `@dub/utils` barrel. A
direct import in the first reported Axiom module only changed one import trace;
the production build then exposed many additional server consumers with the
same underlying failure.

The existing `@dub/ui` package already owns reusable React components and hooks,
is built with an explicit `"use client"` banner, and is externalized from the
utility package. It therefore provides an established client-only boundary for
the i18n runtime.

## Decision

The Weletic React i18n runtime will live in `@dub/ui`. The provider, hooks,
locale dictionaries, locale types, cookie helpers, and language metadata will
move from `packages/utils/src/i18n` into `packages/ui/src/i18n` and be exported
through `@dub/ui`. All client consumers will import i18n symbols from
`@dub/ui`.

The root `@dub/utils` barrel will stop exporting i18n and return to its
server-safe constants-and-functions surface. Server modules will continue using
normal root utility imports; they will not be converted to internal deep import
paths as a workaround. The temporary Axiom deep import used during diagnosis
will be reverted.

## Alternatives considered

- **Dedicated `@dub/utils/i18n/client` subpath** — Keep i18n in the utility
  package behind an export map and update all client consumers. Rejected because
  it adds dual-runtime package semantics and export-map compatibility risk to a
  package with many existing root and internal imports.
- **Convert server consumers to deep utility imports** — Avoid the mixed barrel
  by updating server modules one by one. Rejected because there are roughly
  1,484 root utility consumers, the boundary would remain fragile, and every new
  server import could reintroduce the build failure.
- **Preserve `"use client"` in the generated utility chunk** — Change tsup
  output so the mixed barrel can remain. Rejected because marking shared utility
  output as client code weakens server usage and relies on bundler chunking
  details rather than package ownership.

## Consequences

### Positive

- Next.js server graphs can safely import `@dub/utils` without loading React
  client hooks.
- React providers and hooks have a clear owner in the existing client-only UI
  package.
- New server utilities cannot accidentally inherit browser-only i18n code from
  the root barrel.
- The public utility import convention remains stable for existing consumers.
- Client directives are preserved by `@dub/ui`'s established build configuration.

### Negative / trade-offs accepted

- Approximately 37 client files require mechanical import updates.
- The move produces a broader stabilization diff than a single deep-import
  workaround.
- Locale dictionaries become part of the UI package's client artifact and must
  follow its release and build lifecycle.
- Future non-React localization consumers will need a separately designed
  server-safe locale-data surface rather than importing the UI runtime.

### Follow-ups

- Move the complete i18n directory into `packages/ui/src/i18n` and export it from
  the UI barrel.
- Update every provider, hook, language selector, and translated component to
  import i18n symbols from `@dub/ui`.
- Remove the i18n export and client-specific tsup entry changes from
  `@dub/utils`.
- Revert the diagnostic Axiom deep import and verify normal root utility imports
  remain server-safe.
- Run utility and UI type-checks/builds, the full Next.js production build, and
  Playwright before PR #1 is considered mergeable.

## References

- Hiro approval of Option A, move the i18n runtime to `@dub/ui`, in the Weletic
  Room CI stabilization discussion on 2026-08-16.
- https://github.com/satoshicancode/weletic-room/pull/1
- `docs/adr/0002-launch-locales-en-vi-ja.md`
- `docs/adr/0006-merge-foundation-before-loyalty.md`
- `/Users/hironguyen/.codex/memories/project_adr_0007.md`
- `packages/utils/src/i18n/client.tsx`
- `packages/ui/tsup.config.ts`
