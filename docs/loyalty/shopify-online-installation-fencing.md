# Online session installation fencing — locally verified

Date: 2026-09-07. Follows [ADR 0018](../adr/0018-shopify-owner-and-store-scoped-staff-access.md)
and the session evidence foundation in PR #74. This document is not a release or
live-acceptance claim. Online-token authorization remains disabled.

## Implemented locally

- The signed session POST accepts an optional `onlineCoordination` proof using
  the existing original observation and lease contract. Offline sessions cannot
  use that proof, and online sessions cannot use offline `coordination`.
- Under the existing lifecycle/store lock, publication compares the original
  snapshot, checks the active installation and credential generation, and renews
  only the winning unexpired lease after coordinator lock waits.
- A successful bound write encrypts a strict version-1 envelope containing the
  properties and server-derived app ID, canonical shop, store ID and original
  installation generation. No database column or migration is added.
- Bound identity requires a safe numeric user ID matching the canonical session
  ID, valid owner/scope evidence, a token and finite positive expiry. Expired
  publication is rejected. Binding does not grant owner or operation authority.
- Reads decode legacy property arrays without inventing a binding. The new
  envelope adds `onlineBinding` alongside the existing `properties` response.
  Offline SDK payloads, credential projections and revision are unchanged.
- The coordinated app adapter captures the original observation and request
  timestamp before provider I/O, then validates identity, effective scopes and
  lifetime from the response. New
  sessions cannot be published merely because the current installation is known.
  Fresh SDK expiry is clamped to the conservative pre-request lifetime; cached
  expiry cannot be extended.
- Cached loads require original app/shop/generation and fresh winning ownership.
  Cached write eligibility is scoped to the original operation and invalidated
  by later publication/deletion. Per-operation mutation exclusion and version
  checks also reject concurrent or delayed stale rewrites.
- Bound GET responses include an opaque ciphertext digest. Online deletion uses
  the first loaded digest and original lease, with a conditional SQL delete.
  Retries can return zero deletions, but cannot remove a replacement version.
  Unscoped online deletes now return 400; legacy writes to an already-bound row
  return 409. Legacy arrays still have no installation authority. Lifecycle and
  privacy cleanup use their existing dedicated database services.

## Evidence so far

Local focused tests: 114 passed across five files. Isolated MySQL session
boundary/coordination tests: 28 passed. These exercise actual signed endpoints,
encryption and Prisma transactions; they do not prove live Shopify login.

Full local unit suite: 4,499 passed, six existing skips across 296 files. Web and
Shopify type-checks/builds, root lint (10 tasks), focused lint and changed-file
Prettier checks passed. The web build uses isolated service configuration and
compile mode; complete page generation/browser coverage remains a CI gate.

The real installed SDK validates synthetic signed JWTs, requests an online token,
constructs its own Session and publishes through the production storage adapter.
Wrong signatures, wrong audiences and expired JWTs are rejected before provider
I/O. Provider responses are intercepted; this is not live Shopify authentication.

The added database cases cover successful bound publication, a consistent
replacement installation rejecting the original observation, wrong token/epoch,
expired lease/session, mixed-mode proof rejection, and rollback of lease renewal
after malformed bound identity. Existing offline credentials remain unchanged.
Two real storage clients race through the signed API and MySQL lease while a
provider barrier holds the first exchange: exactly one reaches the intercepted
provider. After a consistent reinstall, the original cached session is rejected.
Separate SDK/client coverage rejects an online exchange whose original offline
observation was superseded by an intervening offline credential publication.

Read-only adversarial review informed stronger replacement-installation,
rollback, expiry and stale-object cases. Final source review found no blocker;
exact-head PR CI remains required before shipping this increment.

## Remaining work in this increment

Complete both GitHub quality gates before merging the focused PR. The evidence
above is local; release completion is not implied while CI remains outstanding.

The backend must roll out before a runtime writes the envelope. No store change,
database deployment, staff access grant, external send or app publication is
authorized or performed by this work. Signed staff actor context, grants,
revocation and live owner/staff/denied-user acceptance remain subsequent ADR
requirements; completing this persistence increment does not complete them.
