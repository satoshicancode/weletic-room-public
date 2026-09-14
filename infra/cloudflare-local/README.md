# Local Cloudflare Containers compatibility

Approved scope: [ADR 0032](../../docs/adr/0032-local-cloudflare-containers-compatibility.md).
This is a local compatibility experiment, **not production deployment setup**.
Do not run `wrangler deploy`, push images, attach credentials or point these
probes at an installed store. No database or queue is created by this directory.

## Architecture under test

- `shopify`: standard Remix Node server, using the opt-in
  `WELETIC_LOCAL_CONTAINER_BUILD=1` build; Vercel remains the default elsewhere.
- `web`: existing Next build/start commands; no Workers-native conversion.
- `worker`: the actual outbox polling loop with synthetic dependency injection.
  It does not load the live worker CLI, Prisma or provider transports. Three
  synthetic batches and signal interruption are process checks, not lease,
  installation-generation, privacy or accounting acceptance.
- `worker-boot`: loads the real CLI with deliberately invalid arguments. The
  smoke check requires argument rejection and cleanup before any store lookup or
  delivery; this is dependency/entrypoint evidence, not successful job execution.

`probe.mjs` accepts only fixed roles and reconstructs child environments from
synthetic literals. Server roles refuse host execution. It forwards SIGTERM and
SIGINT and bounds shutdown. Application builds run without networking after the
dependency install. The image context excludes host dependencies, environment
files, common key files, deployment state and build outputs. BuildKit uses the
image-owned `/opt/weletic-local-probe` marker because its build steps do not
provide Docker's runtime `/.dockerenv` file. This is an accidental-host-execution
guard, not a security sandbox; `--network none` provides the network boundary.
Use this dedicated
clean worktree; do not add credentials under other filenames.

## Commands (repository root)

**Current status (September 14):** the exact-source offline Next build passes
under the 6 GiB cap, including all 353 static pages. Three consecutive packaged
web probes passed at 2 GiB/no swap/1024 MiB heap with sustained anonymous readiness
and clean shutdown. Local-only static-parameter deferral preserves four dynamic
routes and their on-demand fallback. The original 1 GiB runtime profile remains
unaccepted. Typography specimens pass; actual application browser journeys,
emulator resource enforcement and final CI are open. Refreshed Shopify and worker
packaging/process checks also pass at their stated scope in the evidence log.
This is not deployment or loyalty launch acceptance.
Do not increase resources further implicitly. The commands below are
reproducibility references, not instructions to retry.
See [verification evidence](./EVIDENCE.md).
The lightweight Node tests below do not start Docker or database services.

```sh
node --test infra/cloudflare-local/probe.test.mjs
docker buildx build --resource memory=2g --resource memory-swap=2g --resource cpu-quota=200000 --resource cpu-period=100000 -f infra/cloudflare-local/Dockerfile --target shopify -t weletic-cloudflare-local:shopify-runtime-verified .
docker buildx build --resource memory=2g --resource memory-swap=2g --resource cpu-quota=200000 --resource cpu-period=100000 -f infra/cloudflare-local/Dockerfile --target worker -t weletic-cloudflare-local:worker-runtime-verified .
docker buildx build --resource memory=6g --resource memory-swap=6g --resource cpu-quota=200000 --resource cpu-period=100000 -f infra/cloudflare-local/Dockerfile --target web -t weletic-cloudflare-local:web-runtime-verified .
```

Run each locally with no network, host mounts, environment forwarding or
published ports. Internal HTTP probes run in the same container network namespace:

```sh
docker run --rm --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 2g --memory-swap 2g --cpus 2 --entrypoint node weletic-cloudflare-local:shopify-runtime-verified /workspace/infra/cloudflare-local/server-smoke.mjs shopify
docker run --rm --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 2g --memory-swap 2g --cpus 2 weletic-cloudflare-local:worker-runtime-verified
docker run --rm --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 2g --memory-swap 2g --cpus 2 --entrypoint node weletic-cloudflare-local:worker-runtime-verified /workspace/infra/cloudflare-local/worker-boot-smoke.mjs
docker run --rm --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 2g --memory-swap 2g --cpus 2 --entrypoint node weletic-cloudflare-local:web-runtime-verified /workspace/infra/cloudflare-local/server-smoke.mjs web
```

Images are retained locally for reproducibility; containers use `--rm`. No broad
Docker cleanup is needed. The Node 22 candidate is pinned to the resolved image
digest in the Dockerfile; record source and resulting image IDs with evidence.
The emulator Dockerfile consumes `weletic-cloudflare-local:shopify-runtime-verified`.
Build that tag from the reviewed source before emulator verification; an existing
tag alone is not evidence that it contains the current draft.

The Next build checks cgroup v2 limits before spawning compilation and refuses
missing/unlimited limits, memory above 6 GiB, enabled swap or CPU above two cores.
Its Node heap is capped at 4608 MiB; runtime probes use a 1024 MiB heap. The installed
Buildx 0.36 / BuildKit 0.32 stack supports the flags above. A lightweight actual
build proved the cgroup controls, but not that Next fits within the proposed cap.
Limits apply per `RUN` step, not to the entire Docker VM or BuildKit cache/export
work. Run only one application build at a time; do not interpret the guard as
permission to consume all remaining shared resources. The former remote Inter
dependency has been replaced with a bundled asset; offline compilation and
page generation now pass. EN/JA/VI font specimens pass at desktop/mobile widths;
actual application surface acceptance remains separate.

After the first bounded build exhausted its 2304 MiB heap, the local candidate
added `WELETIC_LOCAL_CONTAINER_BUILD=1` for the build role only. Next's custom
Webpack configuration uses no cache and module parallelism two in that mode,
while ordinary builds/dev servers remain unchanged. This is a measured-build
experiment, not a claim that compilation now fits within the cap. Inter is now
bundled under ADR 0033; see [current evidence](./EVIDENCE.md) for actual results.
The cache/concurrency experiment also exhausted the initial 2304 MiB heap. The
subsequent 4 GiB/3072 MiB candidate requires at least 5 GiB of observed VM available
memory before starting, reserving at least 1 GiB beyond the step limit. Do not run
concurrent heavy work or increase the VM/other service limits implicitly. This
headroom check is a point-in-time prerequisite, not a reservation guarantee.
Following the confirmed 4 GiB failure, the approved 6 GiB candidate requires at
least 8 GiB available VM memory (2 GiB beyond its ceiling), with the same no-swap
and two-CPU controls. The Docker VM was explicitly increased to 12 GiB; individual
service limits were not changed.

The local build probe now samples cgroup `memory.current`, `memory.peak`,
`memory.swap.current` and the OOM counters from `memory.events` at startup,
every ten seconds and child close. Logs contain only allowlisted numeric strings
or explicit `null` for unavailable counters. They do not collect environment,
process arguments, application data or heap dumps. A whole-container kill can
prevent the final sample; sampled usage does not establish a safe minimum budget.
An instrumented diagnostic attempt may collect missing evidence under the same
limits and headroom check; it is not an unchanged retry expected to pass.

The candidate now defers partner apply/login/marketplace static-parameter
enumeration only when `WELETIC_LOCAL_CONTAINER_BUILD=1` and Next's
`phase-production-build` phase are both present. It returns no eager paths;
on-demand routes and their request-time fetchers remain in place. Ordinary builds
still enumerate programs and propagate query failures. This is not a database
mock or a reduced application, and does not prove live program rendering.
See [Next's runtime path generation](https://nextjs.org/docs/15/app/api-reference/functions/generate-static-params#all-paths-at-runtime).

## Evidence requirements and remaining work

Record actual commands, exit codes, image/source revisions and failures. The
Next build uses existing separate-validation mode; this is not a substitute for
independent typecheck/lint/tests. A build failure due to unavailable database or
other configuration is an unresolved compatibility result, not grounds to point
the build at a shared database.

Docker process checks precede a Cloudflare local-emulator check. Wrangler routing,
container lifecycle, persistent dependencies, actual worker CLI/lease recovery,
public identity, secrets, regions, costs and deployment remain unverified until
separately demonstrated. Do not infer production readiness from HTTP 404/redirect
responses to the synthetic probe path.

References: [Cloudflare local development](https://developers.cloudflare.com/containers/guides/local-dev/),
[Remix Vite](https://v2.remix.run/docs/guides/vite/).
