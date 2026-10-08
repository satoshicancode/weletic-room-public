# Local web and outbox runtime footprint — September 24, 2026

Source: public `main` at `febe7b696defde6903dd9875a6b558f9711aad1a`
plus the scoped `Web.Dockerfile` change. These are local Linux/amd64 builds,
not Cloudflare deployments or provider acceptance.

The previous current-main web and outbox recipes copied the root workspace
dependency store. Their Docker virtual/unpacked image sizes were **4.86 GB**
and **4.55 GB**, respectively, above the proposed 4 GB instance disk. The
scoped recipe deploys the web workspace dependency graph into each runtime
and generates Prisma Client inside that graph. It retains TSX for the outbox
entrypoint and changes no package manifest or lockfile.

| Role   | Scoped image ID                                                           | Docker virtual/unpacked size | Manifest inspection size |
| ------ | ------------------------------------------------------------------------- | ---------------------------- | ------------------------ |
| Web    | `sha256:5e264e5ac87d522499d917c492685bc52da1b4e1960c56a1e305ee1baab09a4b` | 3.15 GB                      | 585,676,383 bytes        |
| Outbox | `sha256:a3d2cd27fd085e4a5030a872357cbfeec5470957634cf5acec039daef1e98857` | 2.84 GB                      | 539,605,039 bytes        |

Builds used the [documented resource limits](../../infra/cloudflare-release/README.md#weboutbox-candidate-recipes-not-image-acceptance):
two CPU / 2 GiB / no swap for outbox, then two CPU / 6 GiB / no swap for web.
The web production build generated 353 static pages. Local build logs are
`/tmp/weletic-outbox-scoped-prisma-febe7b69-build.log` (SHA-256
`4aa52b5c70ddfb3faa25c0ed7707a91e91ecb1b539439daab863276154243b0c`)
and `/tmp/weletic-web-scoped-prisma-febe7b69-build.log` (SHA-256
`c42e5ac0a20b53e9665f8530eb90174d9db76810778779943bfb3a9b66e2b128`).
These local paths are evidence locations, not portable release artifacts.

The existing `runtime-smoke.mjs` harness passed against both immutable image
IDs using synthetic configuration, no network, read-only filesystems, a bounded
temporary `/tmp`, two CPUs and 2 GiB/no swap. The outbox loaded the real worker
and generated Prisma models, then failed closed at the unreachable loopback
database before store resolution or job delivery. The web served the real Next
handler, rejected excluded and foreign-Host routes with 404, rejected an
unsigned installation-status request with 401 and shut down on SIGTERM. Missing
configuration was rejected before either role started. The harness removed all
of its exact-label containers; none remained afterward. The release-policy suite
passed 141 tests. Independent read-only review found no remaining blocking diff
issue after the first candidate's missing Prisma client was corrected.

These results establish local image fit and guarded boot only. Cloudflare image
admission, deployed memory/CPU, full image inventory, provider connectivity,
supervised restart, live company-store journeys and production economics remain
separate gates. No image was uploaded, resource provisioned, database changed,
or live order or email sent.
