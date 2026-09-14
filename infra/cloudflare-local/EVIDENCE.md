# Local compatibility evidence — September 13–14, 2026

Status: bounded local compatibility candidate based on public main `9b4eb790f7`.
No cloud deployment, image upload, shared schema application or live-store
acceptance was performed. These results do not establish loyalty launch readiness.

## Current checkpoint — September 14

- Exact-source offline web build passed, including all 353 static pages.
- Three consecutive packaged web probes passed at 2 GiB/no swap/two CPUs,
  requiring five consecutive anonymous login redirects and clean shutdown.
- Bundled Inter specimen passed desktop/375px EN/JA/VI rendering and intentional
  font-load-failure checks; this is not an authenticated application UI check.
- Updated full web unit suite passed: 508 files, 8,214 tests passed and six
  existing tests skipped. Repository formatting passed. Hosted CI and publication
  remain separate gates.
- Refreshed Shopify server and synthetic/CLI-boot worker image checks pass;
  they do not establish real authentication, jobs or delivery.
- Emulator resource enforcement, actual application browser journeys and all
  applicable live-store/deployment gates remain open.

The chronological sections below preserve earlier failed and superseded attempts.
Their pending approvals and missing-image statements describe those checkpoints,
not the current state. Final image IDs and precise evidence appear at the end.

## Historical initial checkpoint — September 13

### Passed, with bounded scope

- Shopify unit suite: 191 tests; Shopify typecheck; opt-in standard Node build.
- Docker Shopify server: boot, fixed-path HTTP 404 and supervised shutdown.
  Image: `sha256:53f9c0b77855cb10db1218752961901c4b6f139becc51cf839af43ab0de57aae`.
- Worker: three synthetic batches and real CLI dependency boot followed by
  deliberate invalid-argument rejection, before store lookup or job execution.
- Seven Node probe/process-group tests passed again after the incident.
  These cover environment isolation, fixed commands, host-execution guards,
  synthetic in-flight shutdown and process-group cleanup logic.

The image identifies the tested runtime snapshot, not every later documentation
or test-wrapper edit. Full final-branch checks and CI remain outstanding.

### Failed or not accepted

- Next.js network-isolated build could not resolve `fonts.googleapis.com`.
  It later terminated with SIGKILL and Docker `ResourceExhausted` /
  `cannot allocate memory`. No web image or web runtime acceptance exists.
- During this work the pre-existing dedicated import-test MySQL container was
  OOM-killed (exit 137 at 05:59:49 UTC). Temporal overlap is established; direct
  causality has not been independently proven. No database volumes were deleted
  and no direct database writes were performed by these probes. Post-OOM database
  integrity has not been checked. Eight other existing containers remained up.
- The local Cloudflare emulator returned HTTP 404, but Wrangler 4.131.1 /
  Miniflare 5.20260911.0-alpha automatically configured `SYS_ADMIN`, `/dev/fuse`
  and `apparmor:unconfined` for macOS local Docker. Inspection and independent
  review found no supported disabling override. The emulator was stopped;
  no task emulator containers remained at the subsequent check.

### Required next steps at that checkpoint

1. Resolve recovery approval for the affected import-test database, then check
   startup recovery and integrity without changing fixtures or shared schemas.
2. Establish build resource isolation before further heavy Docker work. Do not
   stop other services or change Docker VM settings implicitly.
3. Resolve the emulator privilege limitation. A dependency downgrade requires
   explicit approval and subsequent verification; an older release is not yet
   proven safe. Do not patch installed dependencies to suppress the warning.
4. Resolve the real font/build dependency without labeling mocks as real builds.
5. Complete Next build/start, final review, full checks and CI before merge.
6. Continue the applicable loyalty acceptance matrix and external launch gates;
   these local probes do not replace real jobs, SQL reconciliation, approved
   public-app installation, shopper journeys or production rollout acceptance.

## Approved recovery and emulator follow-up — 11:29–11:34 UTC

Hiro explicitly approved restarting only the affected import-test database and
evaluating/downgrading the local emulator if suitable. Other services and cloud
resources remain outside that recovery scope. The failures above are historical
evidence, not a statement that the database is still stopped.

- Restarted the existing dedicated import-test MySQL container, retaining its
  existing volume and 2 GiB memory limit. InnoDB initialization and XA crash
  recovery completed; SQL connections succeeded.
- Enumerated all 157 application base tables. Every `CHECK TABLE` returned
  `status OK`; independent exact `COUNT(*)` queries summed to zero rows, matching
  the previously cleaned fixture state. No repair, grant change, schema change
  or application-row mutation was performed. This is bounded post-recovery
  integrity evidence, not full-scale import acceptance or backup restoration proof.
- Inspected the published Miniflare 5.20260815.0-alpha source, then pinned local
  Wrangler to 4.124.0 and regenerated its isolated lockfile. The initial candidate
  rejected compatibility date 2026-09-13; the local probe now uses 2026-08-15.
- Reused the previously built Shopify image; no Next or application rebuild.
  Actual application-container inspection: `Privileged=false`, `CapAdd=null`,
  `Devices=null`, `SecurityOpt=null`. Its proxy had `NET_ADMIN` but no devices or
  unconfined security option. This addresses the observed automatic FUSE addition,
  not every possible security concern. Both containers had no Docker memory limit;
  resource isolation remains a required follow-up.
- Initial requests timed out/returned 500 with connection-refused proxy logs;
  later GET requests returned the expected 404 in 4,132 ms and 11 ms. POST was
  rejected with 404 in 2 ms. The initial failures are unresolved; do not infer
  reliable cold-start acceptance from subsequent success.
- Stopped the exact emulator launcher with SIGTERM (terminal exit 143). Seven
  lightweight Node tests and changed-file formatting passed after the downgrade.
- Post-stop inspection found the emulator proxy still running. Stopped only that
  exact inspected proxy container; a subsequent filtered check found no running
  task containers. Automatic Docker-proxy cleanup is therefore another unresolved
  acceptance item; passing process-group unit tests do not prove Docker cleanup.

Recovery approval is consumed by the bounded restart/checks above, not permission
to stop other services, resize Docker, activate jobs or deploy. The downgrade
remains an uncommitted candidate pending cold-start investigation, review and CI.

## Run-owned cleanup follow-up — 11:36 UTC

- Added a random per-run worker name and bounded cleanup of only validated full
  container IDs under that name. Cleanup waits for the process group to exit,
  refuses unexpected inventories and verifies absence afterward. It does not
  delete images, volumes, stopped containers or other runs' resources.
- Ten Node cases passed, including foreign-run/name rejection, malformed IDs,
  oversized inventories, Docker failure propagation and post-stop verification.
  The normal web Vitest wrapper also passed. Its mocked Docker calls are unit
  evidence, distinct from the actual run below.
- Run `weletic-local-probe-ff4e5c536f36` reused the same Shopify image. Its initial
  GET returned the expected 404 in 3,886 ms. On SIGTERM, the launcher exited 143
  and reported stopping one retained proxy; independent `docker ps` found no
  running containers for that run. The recovered import database remained up
  with `OOMKilled=false`. No other services were stopped.
- This closes the observed proxy-leak reproduction for that run, not exhaustive
  cleanup/crash acceptance. Earlier cold-start failures remain preserved and
  unexplained; one clean startup does not erase them. Next.js packaging and
  build/emulator resource isolation remain incomplete.
- Subsequent review identified repeated-signal interruption and disappearing-ID
  races. The draft now retains signal handlers through cleanup and attempts all
  validated IDs before checking fresh Docker state. Eleven Node tests pass,
  including the new disappearing-application/proxy regression. These later race
  fixes have unit evidence, not a second live-run verification yet.

## Build resource follow-up

- Installed Docker Buildx 0.36.0-desktop.1 and BuildKit 0.32.2 support per-step
  resource limits. A tiny network-disabled build on the cached worker image
  verified actual cgroup values: `memory.max=268435456`, `memory.swap.max=0`,
  `cpu.max=100000 100000`; exit 0. No Docker daemon configuration or existing
  service limits were changed. Only the low-memory proof step was executed.
- Added fail-closed local Next build admission: cgroup memory at most 3 GiB,
  no swap, CPU quota at most two cores, and a build-only 2304 MiB Node heap.
  Twelve Node tests pass; focused independent review found no blockers.
- Per-step limits are not an aggregate build/VM budget. Cache/export operations
  and concurrent builds still need consideration. No claim that Next fits under
  the cap; it has not been retried. The original Google Fonts dependency remains.
- Sources: [Docker resource limits](https://docs.docker.com/reference/cli/docker/buildx/build/#set-cpu-and-memory-limits-for-build-containers---resource)
  and [Next font build-time downloads](https://nextjs.org/docs/pages/api-reference/components/font).

## Pending shared font decision

The requested approval to bundle Inter has not yet been received. No font asset
or shared font configuration has been changed. Read-only inspection confirms
`apps/web/styles/fonts.ts` supplies the root layout's `--font-inter`; the shared
Tailwind `default` family consumes that variable. The impact is the web app's
shared typography, not just one loyalty component.

If approved, preserve the `inter` export and CSS variable, normal variable-weight
behavior, swap loading and existing fallback behavior as closely as possible.
Pin the actual upstream asset/version, retain its copyright/license and checksum,
and compare representative EN/JA/VI screens and generated font metrics. Do not
assume upstream and Google-distributed Inter files are byte- or metric-identical.
The upstream [OFL license](https://github.com/rsms/inter/blob/master/LICENSE.txt)
describes bundling conditions, including retaining the copyright and license.
Satoshi and Geist Mono are outside this proposed change. No new package dependency,
font redesign or deployment is proposed. Offline compilation and bounded memory
acceptance still need real verification after any approved implementation.

## Approved Inter implementation — September 13, 23:20 JST checkpoint

Hiro instructed continuation after the shared-font approval request. ADR 0033
records the accepted change. The earlier pending-decision paragraph is historical.

- Bundled unmodified upstream Inter 4.1 variable WOFF2, original license, public
  license copy and checksummed source record. Shared `inter` export and
  `--font-inter` remain; normal weights 100–900, swap and Arial fallback are
  explicit. Satoshi and Geist Mono are unchanged.
- Actual Next local-font loader tests pass using the real shared module's captured
  configuration and real font bytes. Asset/license checksums and identical public
  license are tested. Fallback metric differences are recorded in the asset README.
- Focused font/probe tests and lint passed; independent font review found no
  concrete defects. Representative EN/JA/VI visual checks remain outstanding.
- Bounded network-disabled Docker build started with 3 GiB memory, no swap and
  two CPUs. Shared packages and Prisma generation passed; Next compilation began
  after the cgroup admission guard. At this checkpoint the build is still running,
  not passed. No new OOM observed for the recovered import database.
- This build's source snapshot precedes the public-license copy and later test
  refinements; even a successful image would need final-source revalidation.
  No PR, commit, deployment or live acceptance is implied.

### Bounded build terminal result

The above build subsequently failed (exit 1). Next's compiler worker exhausted
the explicitly capped 2304 MiB JavaScript heap at about 517 seconds of the Next
step, then exited with SIGABRT. Docker records build
`q5qrnr6heg6nfpzoc3yl7ic5e` as Error. No successful web image was produced.
No Google Fonts download failure appeared in this attempt; that absence and the
font-loader tests are not a substitute for a complete offline build.

After failure the dedicated import-test database remained running with
`OOMKilled=false`; no additional service failure was observed. Preserve the
3 GiB/no-swap resource boundary while investigating compiler memory usage.
No retry should be launched unchanged: inspect local-only cache/concurrency
settings before deciding whether a resource adjustment is warranted.

### Local cache/concurrency experiment — 23:32 JST

Next's installed compiler configuration uses Webpack's default module
parallelism unless overridden. The local-only candidate now disables Webpack
cache and sets module parallelism to two when `WELETIC_LOCAL_CONTAINER_BUILD=1`
and not in development mode. The probe supplies that flag only for `build-web`
after resource admission. Ordinary build/dev defaults remain unchanged.

Three focused Vitest files passed (four wrapper/font/config tests, including the
twelve Node probe cases). Focused lint and independent review passed. These prove
configuration boundaries, not reduced peak memory or successful compilation.

A new bounded build started with the same 3 GiB/no-swap/two-CPU limits and 2304 MiB
heap; result pending at this checkpoint. It includes the public Inter license
copy omitted from the prior build snapshot. No concurrent application build,
resource-limit increase, dependency removal or schema change was performed.
Reference: [Next 15 memory guidance](https://nextjs.org/docs/15/app/guides/memory-usage#disable-webpack-cache).

### Cache/concurrency result and bounded budget follow-up — September 14

The cache-disabled/module-parallelism-two attempt also failed: compiler V8 heap
exhaustion at approximately 336 seconds, SIGABRT, build exit 1. Docker reference
`i3cohn5ky5qdc12xbp7ojx4zb` is Error. Session 8698 is terminal; no image produced.
This does not demonstrate that the cache setting fixes the memory requirement.

Read-only VM inspection then reported 5,403,136 KiB available out of 8,123,340 KiB.
No existing container limit or VM configuration was changed. The next candidate
raises only the build step ceiling to 4 GiB and heap to 3072 MiB, retaining no swap
and two CPUs. A tiny preflight refused launch below 5 GiB VM available; the actual
preflight passed at 5,385,120 KiB, leaving more than 1 GiB observed reserve beyond
the build ceiling. This is not a guarantee against unrelated concurrent work.

Twelve resource/probe tests passed after the ceiling change. Docker reference
`pnxllum2hzi4xf6hv623v6z6k` was Running at 00:02 JST; Next compilation had begun.
The recovered import-test database remained running with `OOMKilled=false`.
Result pending; no further resource escalation or concurrent heavy work implied.

### 4 GiB attempt terminal result — September 14

Session 21545 subsequently returned exit 102. Next's build worker exited with
SIGKILL at approximately 444 seconds; BuildKit reported `ResourceExhausted` and
`cannot allocate memory`. Reference: `pnxllum2hzi4xf6hv623v6z6k`; local log:
`/tmp/weletic-cloudflare-web-4g.log`. No successful web image was produced.
This establishes failure under the bounded candidate, not a measured minimum
memory requirement or proof that a larger shared-machine budget is safe.

Post-result inspection found the dedicated import-test database running with
`OOMKilled=false`; all nine existing service containers were running. No service
restart, VM resize, schema change, deployment or new build was performed during
this follow-up. Web boot and representative typography browser acceptance remain
unverified. Do not repeat the same build or silently raise its resource ceiling.

Whole-draft review identified two documentation defects: a Shopify image-tag
mismatch with the emulator base and stale font/execution-hold instructions. The
README now aligns the tag and describes the current failed bounded experiment.
This correction does not make the compatibility or deployment gates pass.

Post-result focused verification passed: three Vitest files/four tests (including
the twelve Node resource, process and cleanup cases), README/evidence Prettier
checks and `git diff --check`. These are local contract checks, not a successful
Next build, full repository validation, browser acceptance or CI result.

### Numeric-only memory diagnostic — September 14

Read-only inspection of installed Next 15.5.8 confirms parallel server compilation
and parallel server tracing default to false; the candidate does not enable them.
The prior log lacks cgroup usage/event samples, so it cannot establish a safe
minimum budget or attribute memory to JavaScript versus other allocations.

The build-only probe now samples fixed numeric cgroup counters every ten seconds
and on start/close without changing resource limits or compiler behavior. Fourteen
Node cases passed, including numeric filtering, unavailable counters, timer
cleanup and existing isolation/shutdown checks. Independent review found no
blockers, noting a whole-container kill can prevent the final sample.

A real network-disabled, read-only 64 MiB/no-swap container imported only the
read-only-mounted probe file and returned current/peak 8,900,608 bytes, swap 0,
OOM 0 and OOM-kill 0 (exit 0). This proves the sampler reads real cgroup data,
not compiler memory behavior.

One instrumented build was then started with unchanged 4 GiB/no-swap/two-CPU
limits and 3072 MiB heap after preflight reported 5,472,731,136 available bytes
(threshold 5,368,709,120). Session 69378; log
`/tmp/weletic-cloudflare-web-memory-diagnostic.log`. Its result is pending at this
checkpoint. No concurrent heavy work, resource increase or live-store mutation
is authorized by this diagnostic run.

#### Diagnostic terminal result

Session 69378 exited 102; Docker build `1lvquhina4fx7yc3dg7xh1gsc` failed.
At 370 seconds, sampled memory was 4,087,795,712 bytes. At approximately 380
seconds Next's compiler worker received SIGKILL. The final sample captured peak
memory exactly 4,294,967,296 bytes, zero swap, `oom=4`, and `oomKill=1` (all OOM
counters started at zero). This directly confirms a cgroup OOM kill at the build
ceiling. It does not identify which allocations dominated or prove how much
additional memory would suffice. No web image or browser acceptance resulted.

Do not repeat this candidate unchanged. A larger memory envelope requires a safe
capacity decision; alternatively a measured compiler-memory reduction must retain
the complete application and current production contracts. Removing routes,
disabling required functionality or treating a reduced app as launch evidence is
not an acceptable way to pass the build.

Post-failure inspection confirmed all nine existing service containers still
running and the recovered import-test database at `OOMKilled=false`. Host RAM
is 32 GiB; the Docker VM remains approximately 8 GiB. Increasing the VM entails
a separate shared-service interruption/capacity decision and has not been done.

### Independent web validation — September 14

With Docker builds stopped and its capacity change still awaiting approval:

- Host-side full web `tsc --noEmit --incremental false --pretty false` initially
  exhausted a 4096 MiB heap. The repository's existing quality workflow sets
  8192 MiB for this check; matching that setting completed compilation and exposed
  missing package-local dependency links in this isolated worktree.
- Root lockfile SHA-256 matched both the dependency-source checkout and its
  resolved dependency checkout:
  `04ede39afd462f4a010dae707b804a8ac5bc0918e63b886ee87acbcd4e362341`.
  Added only ignored `node_modules` links for `packages/email`, `packages/ui`,
  and `packages/utils`, following the worktree's existing dependency reuse.
  No tracked dependency/lockfile or shared schema change was made.
- Re-running the full web type-check with the CI-sized heap passed (exit 0).
- Full web `eslint . --ext .js,.jsx,.ts,.tsx --max-warnings=0` passed (exit 0).

These host checks used Node 24.16.0; they do not establish Node 22 image build,
full unit-suite, hosted CI, browser or live-store acceptance. The failed Docker
build and pending capacity decision are unchanged. No service was restarted.

### Deterministic suites — September 14

- Full web Vitest run passed: 507 files, 8,206 tests passed, 6 skipped; exit 0,
  duration 630.43 seconds. Local log:
  `/tmp/weletic-cloudflare-full-web-unit-20260914.log`.
  Command: `vitest run --config vitest.config.ts --no-file-parallelism --bail=1
--reporter=dot`, executed through pnpm with a cleared environment, explicit
  synthetic credentials and unreachable loopback database/service URLs. Redis
  and QStash credentials were absent as in the deterministic CI job. Expected
  error-path and missing-provider-configuration warnings appeared; the process
  finished successfully, not merely without visible assertion errors.
- The six explicit skips remain unaccepted: five legacy backfill cases in
  `tests/weletic/e2e/tier1-features.test.ts` (initialization, preview grouping,
  redaction during preview, commit and cancellation), and the administration /
  backfill recovery scenario in `tests/weletic/e2e/tier4-workloads.test.ts`.
  No skips were added or removed. This does not close historical-import gates.
- Shopify package Vitest passed: 5 files, 191 tests; exit 0. Local log:
  `/tmp/weletic-cloudflare-shopify-unit-20260914.log`.
- Shopify package `tsc --noEmit --incremental false --pretty false` passed,
  exit 0 with a 4096 MiB heap.
- `prisma validate --schema=./prisma/schema` passed (exit 0) with eight
  relation-mode missing-index warnings. This validates schema syntax/model
  consistency only; it neither applies the schema nor resolves index performance.

These are local Node 24 checks, not hosted CI, real delivery, real Flow workflow,
isolated MySQL concurrency, public install/reinstall or production acceptance.
No Docker capacity setting, service, schema or live installation was changed.

### Approved 12 GiB VM / 6 GiB build experiment — September 14

Hiro explicitly approved the proposed capacity increase, temporary interruption
of the nine running containers, restoration and a 6 GiB-capped build. No cloud,
schema, live order, email or deployment authority is implied.

- Backed up Docker's settings locally in the private temporary directory
  `/tmp/weletic-docker-resize-20260914.iMgQZ1/`. Modified only `MemoryMiB` to 12288
  with Docker stopped; parsed before/after comparison confirmed that sole change.
  The prior setting was absent (Docker's default). Do not publish the backup.
- All nine containers had `autoRemove=false`; the same IDs were retained, with
  volumes, bind mounts, ports, secrets and per-container limits unchanged.
- Shutdown sequencing issue: Docker Desktop stop was requested before three
  outstanding MySQL stop calls completed. Those calls returned EOF and the three
  containers recorded exit 137, `OOMKilled=false`. Affected: legacy secure MySQL,
  legacy rotation-restore MySQL, and loyalty-dev MySQL. This was not a clean
  shutdown and must not be described as one. Dedicated import MySQL exited 0.
- After restart, all nine original containers were running with `OOMKilled=false`.
  All three affected MySQL logs reported ready for connections; the legacy secure
  server logged completed XA recovery. Its `mysqladmin ping` succeeded; read-only
  `SELECT 1` succeeded on rotation-restore and loyalty-dev. Loyalty-dev's configured
  health check was healthy. These are recovery/liveness checks, not full integrity
  or accounting reconciliation. No volume deletion, repair or schema write occurred.
- Docker reports 12,533,555,200 usable bytes and unchanged 20 VM CPUs. The build
  remains capped at two CPUs; VM usable RAM is lower than the configured 12 GiB.
- Build guard ceiling is now 6 GiB, no swap, two CPUs; compiler heap 4608 MiB.
  Fourteen Node resource/probe/cleanup tests passed after the boundary update.
- Preflight required 8,589,934,592 available bytes and observed 9,658,839,040.
  One build started as session 43499, tag `weletic-cloudflare-local:web-6g`, log
  `/tmp/weletic-cloudflare-web-6g-20260914.log`. Result pending at this checkpoint.
  No concurrent heavy work or further resource escalation is authorized.

#### 6 GiB terminal result

Build `328v73h96t487vtg2815qsfqs`, session 43499, ended with exit 1.
Next compiled successfully in 5.9 minutes; peak cgroup memory was 6,032,101,376
bytes (about 5.62 GiB), with zero swap and zero OOM/OOM-kill events. The approved
budget cleared the previously failing compilation phase, not the full build.

Page-data collection then failed at `/partners.dub.co/[programSlug]/apply`:
`generateStaticParams` calls `getProgramSlugs`, which invokes
`prisma.program.findMany()` against the deliberately unreachable synthetic
database at `127.0.0.1:1`. Source inspection also found program-login static
parameters using the same fetcher, and marketplace static parameters directly
querying programs. Do not solve this by attaching shared database credentials
or removing routes. Build-time route enumeration needs explicit offline handling
that preserves request-time behavior and ordinary deployment defaults.

No web image was produced and no web smoke test ran. Post-build inspection found
all nine restored containers running with `OOMKilled=false`. Docker remains at
the approved 12 GiB setting; no further increase was attempted. Revised resource
tests (14), formatting and diff checks passed. Earlier type/lint/full unit results
predate only the resource-ceiling and evidence changes, not a prerender fix.

### Offline static-parameter candidate — September 14

Added a shared local-build predicate and guarded only the three partner
apply/auth/marketplace `generateStaticParams` entry points. Both the exact local
flag and Next's production-build phase are required. `getProgramSlugs`,
`getProgram`, marketplace request-time data access, metadata and page components
are unchanged. No route, permission, schema or financial behavior is removed.

Tests execute the actual transpiled route modules (including the auth re-export)
with imported data/rendering dependencies stubbed, using the real predicate.
They cover flag/phase combinations, normal result mapping, ordinary query-error
propagation and absence of fallback-disabling route settings. Four focused Vitest
files passed (12 tests, including the 14 Node probe cases); focused lint passed
after renaming a test variable forbidden by Next's lint rule. Independent review
found no blockers. Full updated type-check/build results remain pending here.

The documented Next behavior permits paths absent from `generateStaticParams`
to be generated on demand unless fallback is disabled. These tests establish
the intended source boundary, not successful offline packaging or request-time
rendering with a real database.

### Offline build and HTTP probe results — September 14

- Build `fp9885dwtbtw52308vll71mv0` completed, exit 0. Preflight observed
  9,527,836,672 available bytes against the 8,589,934,592 requirement.
  Next compiled in 8.7 minutes, generated all 353 static pages and completed
  tracing. The build step took 663.9 seconds. Peak cgroup memory was
  5,787,578,368 bytes; swap, OOM and OOM-kill counters were zero.
- Image `weletic-cloudflare-local:web-offline-params`:
  `sha256:dfe79c813c7cc319e3f976fccd327332c423ae14758b8e6a5ff6ee90d55717fc`.
  Application build steps remained network-disabled with no database attached.
- Updated full web type-check passed. Four focused Vitest files passed (12
  tests); full-suite results above predate the static-parameter change.
- The initial HTTP harness selected short-link routing through the loopback
  Host, invoking unavailable Redis/database dependencies. A fixed app Host is
  required to exercise existing anonymous app middleware. Node 22 fetch ignored
  the supplied Host in an isolated echo-server experiment, so the harness now
  uses native HTTP, a fixed loopback destination, a one-second timeout and no
  redirect following. Relative login locations are explicitly supported.
- A read-only mounted harness passed the actual Next startup, expected 307
  `/login?next=%2F__local_container_probe__` response and clean shutdown (exit 0).
  Two prior fetch-based attempts and the initial relative-URL parser attempt
  failed; these were harness failures, not authenticated journey evidence.
- Cached packaging produced `weletic-cloudflare-local:web-verified`, image
  `sha256:73ebc24b9623750de299c5e9bc1486c1db48435bf17963789cfb5740c21d1050`
  (928,682,992 bytes). All application build steps were cache hits. No mounted
  files were used in the subsequent smoke: HTTP returned the expected 307,
  **but shutdown failed**, so this packaged smoke is not a pass.
- A diagnostic rerun mounted only the harness with an added numeric exit/signal
  log. It returned 307 and exited cleanly (`code: 0`, `signal: null`). This
  confirms an intermittent shutdown failure, not its cause or resolution.
  Repeatable packaged shutdown remains required before publishing this draft.
- Read-only inspection of the packaged prerender manifest confirmed apply,
  login, register and marketplace dynamic routes all retain `fallback: null`.
  This is route packaging evidence, not successful database-backed rendering.
- Fifteen Node probe/resource/process-group/cleanup tests passed. Independent
  review of the HTTP harness found no blockers. Nine existing service containers
  remained running; loyalty-dev MySQL was healthy. No deployment, image upload,
  schema application, real credential injection or live loyalty mutation occurred.

### Runtime capacity and readiness diagnostics — September 14

The original runtime command allowed swap and set a 4096 MiB Node heap inside a
1 GiB container. Instrumented successful runs reached exactly 1,073,741,824 bytes
and retained 12,169,216–12,873,728 bytes of swap. An earlier uninstrumented repeated
run returned child-wrapper code 1; its exact child signal was not captured.
Therefore neither that failure's precise cause nor 1 GiB runtime viability is
proven. Early HTTP success is not reliable evidence of completed initialization.

A 512 MiB heap diagnostic with the same 1 GiB memory limit and swap disabled
failed with a V8 heap exhaustion at about 15 seconds. The child signal was
`SIGABRT`, `forcedShutdown: false`; peak memory 715,530,240 bytes, swap/OOM/OOM-kill
all zero. This was a JavaScript heap failure, not the shutdown watchdog or kernel
OOM killer. Next 15.5.8 source enables background `preloadEntriesOnStart` by
default and loads application entry modules. That is a plausible contributor to
the observed loading pressure, not a profiled allocation attribution. No route
preloading, feature, authentication check or runtime database access was removed.

The next ephemeral local probe used 2 GiB memory, no swap, two CPUs and a 1024 MiB
heap. It passed HTTP and clean shutdown at peak 1,157,865,472 bytes. No Docker VM
setting or existing service limit changed. This is local diagnostic capacity,
not approved cloud provisioning, production sizing or load-test evidence.

Adding sustained readiness initially exposed a one-second transport timeout
during cold loading, while shutdown remained clean. Independent review also
identified that the original shared 35-second watchdog could shorten the child's
15-second shutdown grace after slow readiness. The harness now requires five
consecutive valid responses within a separate 30-second readiness window, resetting
on transport errors but failing immediately on incorrect HTTP responses. Shutdown
gets a fresh 20-second outer guard around the unchanged 15-second child grace.
Numeric cgroup counters and fixed-role child exit/signal/watchdog diagnostics are
logged; no environment or customer data is collected.

Seventeen Node tests passed, including fake-clock late-readiness, consecutive-count
reset, failed-response, process-exit and deadline tests. The actual mounted-source
run (session 35185) passed sustained readiness and clean shutdown: child code 0,
no forced shutdown, peak 1,154,179,072 bytes and zero swap/OOM/OOM-kill events.
Fresh packaged-image verification and repeated runs remain outstanding; the
existing `web-verified` image still contains the earlier harness. Its tag alone
must not be treated as evidence for these newer changes.

Independent re-review found no remaining harness blockers after the separate
readiness/shutdown deadlines. Public main remains
`9b4eb790f736ae215792c7a0e271785f7d59b1ab`; no public PR is open for this draft.
A fresh build of `weletic-cloudflare-local:web-runtime-verified` is running as
session 88395. Preflight observed 9,399,595,008 available bytes (required
8,589,934,592); limits remain 6 GiB/no swap/two CPUs and build heap 4608 MiB.
Log: `/tmp/weletic-cloudflare-web-runtime-verified-20260914.log`.
Poll this same live build; do not restart on an observation timeout.
Its final result, packaged smoke repetitions, updated remaining checks and PR
publication are pending at this checkpoint.

Pinned-emulator source inspection (Miniflare `5.20260815.0-alpha`, bundled
`dist/src/index.js`) found that its workerd `ContainerOptions` structure exposes
the image name and privilege fields, but no memory/CPU resource fields. This is
consistent with the earlier actual Docker inspection showing uncapped emulator
containers. Merely adding a cloud `instance_type` setting would not establish
local enforcement. Do not rerun the memory-heavy web runtime through that emulator
or claim production sizing from the separate capped Docker probe. Resource-safe
emulator execution remains a distinct unresolved gate.

### Exact-source packaged web result — September 14

Build `sprs4v44sdp07w6zwc0yjtj3m` (session 88395) completed with exit 0.
The Next step took 588.7 seconds; image export took 12.8 seconds. It compiled in
7.5 minutes, generated all 353 static pages and completed tracing. Peak cgroup
memory was 5,787,914,240 bytes with no swap or OOM/OOM-kill events.

Image `weletic-cloudflare-local:web-runtime-verified`:
`sha256:c80127ceaa1ddcf25021aa489fa9796b8266d91a731d7361ebce05e8b68d0542`,
928,671,647 bytes. Three sequential no-mount probes (session 6402) all passed
five consecutive ready responses and normal child exit 0, with no forced shutdown.
Memory peaks were 1,171,083,264, 1,181,540,352 and 1,173,123,072 bytes; swap and
OOM/OOM-kill counters were zero in all three. Each used 2 GiB, no swap, two CPUs,
read-only filesystem, temporary `/tmp`, no capabilities and no network/host ports.
Log: `/tmp/weletic-cloudflare-web-packaged-smoke-20260914.log`.

Read-only inspection confirmed the four guarded dynamic routes still have
`fallback: null`. The packaged Inter asset checksum matches the pinned source
asset. Its actual emitted CSS retains weights 100–900, normal style, swap loading
and the measured Arial fallback metrics recorded by the loader test.

### Typography browser specimen — September 14

Playwright/Chromium inspected an isolated synthetic specimen using the emitted
font-face declarations and the exact matching font asset. Screenshots at 1280×900
and 375×812 were visually inspected: EN/JA/VI text, Vietnamese diacritics, numerals
and weights 100/400/700/900 had no visible missing glyphs or clipping. Document
scroll width matched viewport width; each language section had no horizontal
overflow. A keyboard-focused specimen button had a visible solid outline.

Chromium's platform-font inspection reported `Inter Variable` for English and
Vietnamese headings and `Hiragino Kaku Gothic ProN` for Japanese headings.
Inter is not being claimed to supply Japanese glyphs. The only loaded specimen
resource was the loopback-hosted WOFF2. When that request was deliberately aborted,
Inter had status `error`, the Arial fallback loaded, and the 375px specimen stayed
readable without horizontal overflow. The expected request error is not an
unexplained browser failure. Fallback weight appearance differs; this is not a
pixel-equivalence claim against the former Google distribution.

Local-only artifacts under ignored `output/playwright/`: `inter-desktop.png`,
`inter-mobile.png`, `inter-mobile-fallback.png`, specimen HTML/server and
`cli-session-20260914/`. These are font specimens, not shared shopper components
or an accepted live journey; no account, transaction or provider is connected.

An additional actual login-page preview remained unverified. Its initial local
container was started on Docker's default bridge, then stopped and recreated on
an internal network before browser navigation; only synthetic configuration was
present. Browser requests were restricted to the loopback app origin. The internal
network did not publish the requested host port (`3000/tcp: []`), so both browser
and curl connections failed. No less-isolated retry was made. Both preview
containers, the exact temporary network, browser session and font-specimen server
were stopped/removed. The nine pre-existing service containers remained running,
with loyalty-dev MySQL healthy. This does not establish a successful application
browser render or database integrity audit.

The fresh full-source deterministic web suite completed with exit 0, log
`/tmp/weletic-cloudflare-current-web-unit-20260914.log`, using synthetic
`probeEnvironment` configuration and an 8192 MiB host test heap matching CI.
It passed 508 files and 8,214 tests, with six existing legacy backfill tests
skipped, in 630.74 seconds. Skipped tests are not acceptance evidence. This fresh
result supersedes the earlier full-suite count. Repository-wide `pnpm
prettier-check` also passed, and the staged diff whitespace check passed. These
local results do not substitute for hosted CI or named live-store acceptance.

### Refreshed Shopify and worker images — September 14

The 32 GiB host and 12 GiB Docker VM leave separate headroom for the 8192 MiB
host unit-test heap and these 2 GiB/two-CPU capped local builds. No VM or existing
service limits changed; the 6 GiB Next build had already completed.

- Shopify image `weletic-cloudflare-local:shopify-runtime-verified`:
  `sha256:db0cfa97230d7aca64722df77f1dd9a46bd02ee86c3cc11777356695647ac7fa`,
  881,011,892 bytes. Offline Remix build passed in 18.3 seconds. Existing
  source-map reporting warnings are not interpreted as failed compilation.
  The packaged server passed five consecutive fixed-path 404 responses and clean
  child exit 0, with no forced shutdown. Peak runtime memory 154,509,312 bytes;
  swap/OOM/OOM-kill zero. This deliberately missing route proves server dispatch,
  not merchant authorization or embedded UI acceptance.
- Worker image `weletic-cloudflare-local:worker-runtime-verified`:
  `sha256:851499c8c6c24d4786294d389f40a4b539e86931405950031ba778818e9f802d`,
  880,468,321 bytes. Build reused the current shared dependency layers and packaged
  the current harness. Three injected synthetic batches completed with child exit 0. The real worker CLI then loaded and rejected its invalid argument before
  delivery, with the expected stopped marker. These remain synthetic/boot checks,
  not actual outbox, lease, generation or privacy acceptance.

All runtime checks used 2 GiB/no swap/two CPUs, read-only containers, temporary
`/tmp`, no added capabilities and no network or mounted files. Example build/run
commands and the emulator base tag now identify these current image tags.
Changing the emulator's base tag does not certify an actual emulator run or fix
its unresolved local resource enforcement.
