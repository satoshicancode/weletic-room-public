# Isolated local release verification

Authority: [ADR 0037](../../docs/adr/0037-isolated-local-release-verification.md).
No cloud provisioning, image upload, live credentials or application mutations
are included. Docker Desktop and its saved workloads must remain stopped.

## Local setup

The September 17 environment uses Lima 2.2.0 on Intel macOS with native VZ:

- Official `lima-2.2.0-Darwin-x86_64.tar.gz` SHA-256:
  `0d6f99c19f6e4bc3c92730c4c29d929e6927f0cb0a0ba1a84383367135a8ff31`.
- Dedicated user-local installation and separate `LIMA_HOME`; no system package
  manager, shared Docker context or Docker Desktop state was changed.
- `docker-rootful` template, four CPUs, 8 GiB memory, 80 GiB sparse disk, no mounts,
  no SSH-agent forwarding or loading of host SSH public keys.
- Ubuntu 26.04 amd64 image dated 2026-07-20, pinned by the template to SHA-256
  `117816726abbdefc5ef3e38902e81a76f1c76c3610e709999d0885f9d5d9b477`.
- Guest inspection reported 7,934 MiB total RAM, four CPUs, cgroup v2, zero swap
  and no virtiofs/9p/SSHFS mounts. The daemon initially had no containers.

Catch-all port-denial rules **precede** the Docker Unix-socket forward. Cover
both wildcard and loopback guest addresses with `proto: any` and `ignore: true`.
The accepted startup log must explicitly say TCP (except management SSH) and UDP
port forwarding is disabled. During initial setup, placing the socket rule first
left UDP discovery forwarding enabled; that VM was stopped and the order fixed
before any image build. Do not rely on a TCP-only ignore rule.

Use an explicit `unix:///.../sock/docker.sock` on every Docker invocation and an
empty task-specific Docker configuration (only the existing CLI plugin directory
is added). Never switch the user's current context or inherit registry auth,
TLS overrides, SSH agent or application environment. Send the reviewed Docker
build context through the socket; do not mount the source tree or host home.

## Image checks

Build the two targets sequentially with the resource bounds in
[README](README.md#weboutbox-candidate-recipes-not-image-acceptance). Store the
immutable local image IDs; never use a mutable tag as smoke-test authority.

```sh
node infra/cloudflare-release/runtime-smoke.mjs outbox sha256:<image-id> unix:///<isolated-socket>
node infra/cloudflare-release/runtime-smoke.mjs web sha256:<image-id> unix:///<isolated-socket>
```

The harness never pulls images. It requires Linux/amd64, the expected non-root
guarded entrypoint and no baked fixture configuration. It reuses exact random
name/label cleanup from the Shopify runner. Containers have no network or host
mounts, no published ports, read-only filesystems, temporary `/tmp`, two CPUs and
2 GiB/no swap. Missing configuration must exit 1 before application startup.

- **Web:** exercise the real packaged Next handler, requiring 404 for excluded
  routes/foreign Host and 401 for a missing signature on the installation-status
  POST. Then require graceful SIGTERM exit without OOM or forced kill.
- **Outbox:** require the real worker and native Prisma client to load and fail
  on the deliberately unreachable loopback database before resolving a store.
  This is fail-closed boot evidence, **not** successful job delivery, lease
  recovery or graceful shutdown of an active batch.

Known-environment checks are not a complete layer/secret audit. Record any
additional filesystem scans separately. Provider-connected authentication,
company-store admission, financial jobs, real email, watchdog/scheduling and
Cloudflare deployment remain independent acceptance gates.

## Cleanup

Confirm no `weletic.release-smoke` containers remain on the isolated daemon.
Stop only the named dedicated Lima instance. Retain its local tool installation,
VM disk and build cache for repeatable checks; they are not running services.
Do not remove Docker Desktop data or unrelated containers, contexts or networks.

## Results

The outbox candidate built from the PR #66 recipe on Linux/amd64:

- Image ID `sha256:ebe283dac556611da834aadbca66243aab139bb207ac8edfc38258d11af7eb5e`.
- Docker `image inspect .Size` after execution: 4,546,450,022 bytes (not total
  VM/cache disk usage). The initial pre-execution query reported 816,157,286 bytes;
  use the post-execution value for this checkpoint, not that earlier figure as a
  deployed-size estimate.
- Missing configuration rejection passed. Real guarded worker/Prisma startup
  reached the deliberately unreachable database and exited 1 before store
  resolution/job processing. No OOM occurred; both exact smoke containers were
  removed. Active-batch shutdown and actual delivery remain unverified.
- Docker Engine 29.8.1; builds used the existing Buildx 0.36.0 desktop CLI plugin
  against the isolated socket, without starting Docker Desktop.

The first web build correctly stopped at the context guard because BuildKit does
not provide `/.dockerenv`. The recipe now creates `/opt/weletic-release-build`
only in the build stage, while retaining finite cgroup and dotenv checks. That
marker is not copied into the fresh runtime. It prevents accidental unsupported
execution; it is not a security attestation against a malicious host.

The corrected build passed admission, compiled successfully in 19.9 minutes and
generated 353/353 static pages. The actual build cgroup reported a 6 GiB memory
limit, zero allowed swap and a two-CPU quota; the sampled memory peak reached
5,582,143,488 bytes with zero OOM events. Existing Next route-metadata/browser-data
warnings and missing-provider warnings were emitted. No provider credentials were
added to silence them.

Web candidate result:

- Source: public `main` at `5b467ff12b9bf0b9a916550a9800352503826647`, plus
  this change's BuildKit marker fix. No business logic or schema changed.
- Image ID `sha256:ffe74dfdbe5a1afe4da2f4645f3de259bfe6d6b54a11b9e8e80b792f010ded77`.
- Docker `image inspect .Size` after unpacking: 4,849,154,006 bytes. Initial
  pre-unpack metadata reported 861,812,694 bytes; neither is total VM/cache usage.
- The full Next build step took 1,560.2 seconds; layer export took 657.5 seconds
  and local unpacking 644.9 seconds. These cold local timings are not Cloudflare
  deployment/startup measurements. Image minimization remains outstanding.
- Missing configuration exited 1. The real packaged server returned 404 for
  excluded auth routes and a foreign Host, and 401 for an unsigned installation
  status POST through Next. SIGTERM completed within the harness limit with no
  forced kill/OOM. Both exact smoke containers were removed.
- This proves bounded local boot, routing/auth rejection and idle shutdown,
  **not** authenticated merchant requests, provider connectivity or live loyalty.

Verification: 132 Node release-policy tests, the focused Vitest wrapper, web
TypeScript, focused ESLint, Prettier and Prisma validation passed. Prisma emitted
existing relation-index warnings. Independent read-only review found no blocking
issue. A complete filesystem/layer secret audit and vulnerability review remain
open; metadata assertions alone do not establish those gates.

Cleanup: the isolated daemon had zero containers after verification. The default
Docker context remained `desktop-linux`, and its socket stayed absent. The
dedicated Lima instance shut down successfully at 14:24 JST on September 17;
its installation, disk and cache were retained, with no running application
services. The original historical-import worktree was not modified.

## September 24 Shopify runtime footprint

Source: public `main` `037e80febde2b6ccedb67ddd5b0285d30f63f7c7` plus
the Shopify Dockerfile/runtime-copy change in this branch. The unchanged recipe
built an unpacked 4.47 GB Docker image, dominated by a 3.43 GB root
`node_modules` layer. This exceeds the proposed Cloudflare `basic` instance's
[4 GB disk](https://developers.cloudflare.com/containers/platform/limits/).
The full workspace dependency store is not needed by the packaged Remix server.

The revised Dockerfile resolves a lockfile-frozen production dependency graph
in a dependency-only stage before copying application source. It copies that
graph into the final Shopify package, alongside the compiled server and both
runtime-policy modules. Application builds remain network-disabled. No package
manifest or lockfile dependency was removed or downgraded.

- Linux/amd64 local image ID:
  `sha256:a5fc42269875f3dd0b0cb3313b043d65492074855465ad12a8d88147444c13e7`.
- Docker's unpacked image-list size after build and execution: **980 MB**.
  `image inspect .Size` reports 190,345,356 bytes on this Docker Engine; use
  the unpacked figure for the local disk comparison. Neither
  figure is a Cloudflare deployment/startup measurement.
- Five static Shopify image-policy tests passed. The no-network, read-only
  smoke passed missing-configuration rejection, real Remix HTTP readiness and
  rejection of the excluded path, and SIGTERM without OOM. It used synthetic
  configuration, published no port and removed its exact containers.
- The first slim image failed boot because the recipe had omitted the policy's
  local `preview-origins.mjs` import; the final image includes it and passed the
  same smoke. No provider connection or live Shopify journey was exercised.

The 4 GB disk candidate now has local image-size headroom. Runtime memory,
Cloudflare image admission, provider compatibility, authenticated installation,
extension ownership and worker supervision remain separate release gates.
