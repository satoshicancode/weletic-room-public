# Authenticated merchant overlap — September 19, 2026

Initial checkpoint: **failed live acceptance; investigation required**. Runtime source:
public main `53553f1cb886e14143b6cc272b1527f439391900` (PR #84). Its PR and
post-merge quality gates passed. These observations do not establish a regression
relative to an earlier build: no controlled pre-fix comparison was performed.

## Scope

Continued the approved isolated local + Shopify CLI acceptance on yamaxdev
(canonical montdev), using the existing public app and retained local volumes.
Only authenticated merchant reads were exercised. No configuration Save,
activation, order, redemption, refund, email, schema application, historical event
repair, subscription deletion or production deployment was performed.

The 13 isolated-service checks passed. CLI configuration validation reported no
issues and the public preview became Ready with the existing seven scopes.
An initial tunnel attempt inherited the host's unrelated Cloudflare configuration
and returned 404 before reaching the app. Restarting only the task tunnels with
an explicit empty configuration fixed routing; the saved host configuration was
not edited. The public boundary returned 404 for the private session endpoint
and 401 for an unsigned integration webhook.

## Observed results

1. Native embedded authentication completed and the overview showed company
   approval. The loyalty editor loaded the existing disabled program.
2. A second tab independently loaded the same configuration. Concurrent reloads
   completed with both tabs showing Disabled. Browser-control timeouts required
   fresh accessibility observations; they are not recorded as app failures.
3. Concurrent navigation from both configuration pages to Rewards produced real
   HTTP 409 session-coordination responses. One tab displayed the existing fixed
   reward; the other displayed: “Result unavailable or uncertain. Reload before
   making changes.”
4. The failed tab's explicit Reload did not recover. Closing the successful tab
   and trying one further isolated Reload also left the same error. No write or
   redemption was attempted.

The retained logs show repeated snapshot 200 / coordination 409 sequences but
do not identify each coordination action/error code or correlate it to a browser
operation. They therefore cannot distinguish exhausted contention, stale state,
an abandoned lease, or another fenced rejection as the final root cause. There
were no logged TimeoutError occurrences in the clean attempt. Do not increase
retry limits or weaken session fences on this evidence alone.

## Independent SQL reconciliation

Before and after: program disabled; 16 ledger entries summing to -300; account
cache -300; pending zero; lifetime earned 7,800. Afterward, the sole reward was
inactive, with 58 processed and nine failed webhook rows. No historical failed
row was replayed or edited.

At 11:44:41.786 UTC the session coordination row had revision 10, epoch 153,
a non-null owner, and expiry 11:44:09.688 UTC (already expired at that sample).
This is a diagnostic snapshot, not proof that the expiry caused the earlier
request failures. No lease or credential was manually cleared.

## Next bounded investigation

- Correlate each SDK operation with acquisition/renewal/release, allowlisted
  rejection code, attempt and elapsed time. Never log tokens, owner hashes,
  customer identifiers or signed URLs.
- Reproduce the two-tab reward read and isolated Reload using existing contracts;
  identify whether failure is lease exhaustion, observation change or nested
  operation/release behavior before selecting a fix.
- Add a regression test for the proven cause, independently review auth changes,
  run the full checks, then repeat the same no-financial-write live scenario.
- Definition of done: both reward reads and subsequent isolated Reload complete,
  fences still fail closed, and the unchanged financial baseline reconciles.

Raw diagnostic logs remain local and are not included in the public repository.
Full loyalty acceptance and financial duplicate/recovery tests remain open.

Cleanup verified: both test browser tabs closed; CLI, backend, ingress and task
tunnels stopped; all five isolated containers stopped and their volumes retained.
The dedicated Lima instance reported Stopped, and no application/SQL test ports
remained listening. Neither app was uninstalled and neither theme was published.

## Follow-up: duplicate mount reads reproduced and fixed

Hiro approved tracing and fixing the proven cause with regression tests and the
same bounded live retest. Temporary local instrumentation recorded operation IDs,
coordination actions, allowlisted outcomes and elapsed times only. It was removed
before the final diff; no logging or runtime authentication contract is changed.

The real explicit Reload pair succeeded: one operation received four confirmed
`lease_busy` rejections, then acquired after its peer released. In contrast, the
original simultaneous Program → Rewards navigation reproduced excess operations:
two online operations acquired and released, while two others exhausted attempts.
One page showed its catalog and the other showed the uncertain-result error.

The app uses development React StrictMode. The reward catalog effect dispatched
its read immediately; StrictMode's setup/cleanup/setup cycle started a second
read even though the first result had been discarded. Ignoring a response does
not prevent its online authentication from consuming the shared shop lease.
The regression test demonstrated exactly two dispatches against the old code.

The fix defers only the effect's initial read by one microtask and checks its
closure-local lifetime before dispatch. Discarded effects never start a request;
explicit Reload still reads afresh. Already-dispatched stale results remain
ignored. No result cache, lock substitute, mutation retry, lease extension,
authentication bypass or changed acquisition budget is introduced.

### Retest and verification

- On yamaxdev, repeating simultaneous Program → Rewards navigation with the fix
  loaded the existing fixed reward in both tabs. After closing the second tab,
  an explicit isolated Reload also succeeded.
- Diagnostics showed both acquired operations released; independent SQL then
  showed coordination revision 11, epoch 186 and `leaseExpiresAt = NULL`.
- Program remained disabled; reward inactive; ledger count 16 and sum/cache -300;
  pending zero; lifetime earned 7,800. Webhook totals remained 58 processed and
  nine failed. No financial mutation or historical repair occurred.
- 252 focused tests across seven files passed. Coverage adds StrictMode, cancelled
  pre-dispatch visits and stale read responses. The online-auth fixture now models
  one exclusive owner, checks release token/epoch, and tests both recovery before
  contention exhaustion and a fresh operation after exhaustion and release.
- Independent adversarial review found no blockers. Both browser tabs, test
  tunnels, CLI/framework processes, backend, ingress, containers and dedicated VM
  were stopped; volumes and historical evidence retained.
- Web and Shopify typechecks/builds, focused ESLint, Prisma validation, Prettier
  and diff whitespace checks passed. The web build used the isolated loyalty-only
  build environment without live credentials. Generated build/config artifacts
  are excluded from the change.

This closes the reproduced reward-catalog duplicate-mount issue and this bounded
two-tab retest, not every historical intermittent merchant failure. In particular,
the initial checkpoint's persistent Reload failure/expired-owner snapshot has not
been independently attributed to a lease leak. Other merchant surfaces, cold-start
load, higher concurrency, financial duplicate recovery and full loyalty acceptance
remain separate gates. The development StrictMode finding does not assert that
production React performs duplicate mount effects.
