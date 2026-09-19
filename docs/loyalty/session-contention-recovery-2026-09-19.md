# Bounded session contention recovery — September 19, 2026

## Scope and evidence

The [financial acceptance run](yamaxdev-financial-acceptance-2026-09-19.md)
encountered recoverable authentication/loading and save failures. Retained logs
contain two HTTP 409 coordination responses and a client acquisition rejection.
They do not establish the cause of every uncertain merchant save. This change
addresses confirmed acquisition contention only, not cold-start or arbitrary
provider/network failures.

Hiro approved typed coordination errors and bounded waiting before authentication
exchange or business writes, without retrying an uncertain outcome or weakening
installation/session fences. No schema, public API, scopes, credentials, runtime
services or live store state changes are included.

## Contract

- The signed internal gateway preserves an allowlisted coordination code only
  for HTTP 409 from the exact session-coordination path. Generic conflicts,
  other endpoints and server errors cannot authorize retry.
- Acquisition permits at most five attempts, separated by 100, 200, 400 and
  800 milliseconds. Snapshot reads, waits and acquisition requests share an
  eight-second monotonic budget; each request receives the remaining deadline.
- Only an explicit `lease_busy` rejection can enter this wait path. The backend
  returns that rejection from a rolled-back acquisition transaction. Timeout,
  malformed acknowledgement, unknown conflict and transport failure fail closed.
- Each wait is followed by a fresh snapshot. A newer lease epoch is permitted;
  changed revision, session digest, credential hash or installation generation
  rejects the operation. The original financial/configuration revision fences
  remain unchanged.
- No retry wraps token exchange, renewal, publication, merchant writes or business
  callbacks. Ambiguous merchant saves still require authoritative reload before
  the user retries. No same-process cache or mutex substitutes for database lease
  authority.

## Verification and remaining gates

The focused six-file suite passed 171 tests. Tests exercise the actual Shopify SDK
with intercepted synthetic HTTP, not a live provider or real database race.
Coverage includes bounded contention success, attempt/deadline exhaustion,
independent observation-field changes, failed snapshot refresh, generic/blocked/
stale conflicts, ambiguous/late acquisition and unchanged exchange/publication safety.
Independent adversarial review found no blockers. Web and Shopify typechecks,
focused lint, Prisma validation, Shopify build and the credential-isolated
loyalty-only web production build passed; Prisma retained existing relation-index
warnings. The isolated build emitted expected missing Redis/QStash configuration
warnings and did not connect to live services.

This does not prove that the intermittent live merchant failures are eliminated.
A separately scoped authenticated merchant/preview overlap test is still needed;
it requires no new financial orders. Historical financial-event recovery,
subscription cleanup and full loyalty acceptance remain separate.
