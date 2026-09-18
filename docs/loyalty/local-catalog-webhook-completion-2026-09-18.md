# Local catalog webhook completion — September 18, 2026

Follow-up to the [observed overlap failure](public-webhook-delivery-2026-09-18.md).
Hiro approved fixing local completion/retry handling, regression coverage and a
repeat of the archived-product tag add/remove test. No schema migration or
production queue redesign is included.

## Contract

- Local catalog topics run through the same dispatch, failure and fenced terminal
  completion path as other operational webhooks. They no longer swallow catalog
  failures or mark events processed merely because background work started.
- The local response waits at most one second for processing after claiming the
  event. Pending work returns 503 with Retry-After 60, retaining Shopify's retry
  responsibility. Lock or sync failures persist failed and return non-success.
- Background completion updates the durable event only after sync succeeds, under
  its original attempt and installation generation. A later signed Shopify retry
  observes processed and returns 200 without repeating the sync.
- Received local catalog claims use a thirty-minute reclaim window instead of one
  minute. Other topics keep their existing lease. A running duplicate is retryable;
  a failed claim remains immediately reclaimable.
- Catalog sync checks an optional expected installation generation against its
  acquired credentials before creating a sync run or performing Shopify reads.
- Request logs record the bounded response actually returned, not an eventual
  background success that the caller never received.
- Production catalog topics retain the existing QStash handoff. Financial and
  privacy processing, signatures, tenant checks and payload minimization remain
  unchanged. No new public API or stored raw payload is introduced.

## Limits

This is an explicit local-preview fallback, not a durable worker queue. Process
termination can leave a received claim; Shopify redelivery may reclaim it after
thirty minutes. That window is not renewed with the Redis catalog lock, so very
long syncs can still require another full retry. Keep the preview online until
pending test work and provider acknowledgements finish. Production scheduling,
supervision and crash-recovery acceptance remain separate gates.

## Verification

Focused synthetic tests cover slow processing without early completion, actual
response logging, lock and provider failures, duplicate received/processed events,
the extended local reclaim predicate, stale trigger credentials, timer cleanup,
bookkeeping rejection and unchanged production handoff. Independent review found
no blockers. Synthetic tests do not replace the live evidence below.

The focused and adjacent webhook suite passed 136 tests across six files. Web
typecheck passed with the CI-standard 8 GB heap after the default heap exhausted;
focused lint, formatting, Prisma validation, Shopify typecheck and Shopify build
also passed. Prisma retained its existing relation-index warnings.

The live retest uses the same archived fixture and public app on yamaxdev, the
isolated SQL/Redis runtime, unchanged scopes and disabled loyalty/delivery. It adds
then removes only `weletic-webhook-retest-20260918-1441`. No new order, financial
repair, subscription deletion, email, uninstall or production deployment is included.

### Live result: passed for the bounded overlap

| Event       | First received, JST | Intermediate result                                                                                                | Terminal result                                                             |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Tag added   | 14:41:19.958        | HTTP 503 after 1,229 ms; received, attempt 1; concurrent retries did not reclaim                                   | Processed at 14:43:06.323, attempt 1; subsequent Shopify retry returned 200 |
| Tag removed | 14:42:13.336        | Two lock-contention attempts persisted failed with HTTP 500; next automatic delivery started sync and returned 503 | Processed at 14:45:06.789, attempt 3; subsequent Shopify retry returned 200 |

These were actual signed Shopify deliveries, not fabricated HMAC requests or
manual event-status edits. An unsigned probe returned 401. Both new event rows
retained authenticated body digests. Native authentication and a read-only
currentAppInstallation query verified the public app and canonical store.

Shopify Admin confirmed empty tags, archived status and the original JPY 1,000
price. Independent SQL confirmed empty catalog tags at 14:43:22.260 and successful
full sync at 14:45:06.763. This also removed the stale projection from the earlier
failed test through normal synchronization, without rewriting financial history.

The final SQL baseline remained ten ledger entries totaling -200 points, zero
pending points and a disabled loyalty program. The nine historical failed financial
events and attempts were unchanged. The subscription audit still contained the
same three stale groups (48 subscriptions); none targeted this preview and none
was deleted. The previously observed remote API-log sink limitation remains open.

After both final HTTP 200 retry acknowledgements, the CLI, tunnels, ingress,
backend, five containers and dedicated VM were stopped with their data preserved.
This does not close other topics, privacy/crash races, subscription cleanup,
financial duplicate recovery, production scheduling or full loyalty acceptance.
