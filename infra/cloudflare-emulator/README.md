# Local-only Cloudflare emulator

**Experimental candidate (September 13):** Hiro approved evaluating and downgrading
the local toolchain. Wrangler is now pinned to 4.124.0 with compatibility date
2026-08-15. Unlike the rejected 4.131.1 run, actual inspection found no added
application capabilities, devices or unconfined security setting. The networking
proxy still uses `NET_ADMIN`. Initial cold-start requests failed before later
requests passed; startup reliability and resource limits remain unaccepted.
See [evidence](../cloudflare-local/EVIDENCE.md). This is not a production pin or
clearance to rerun heavy application builds.

This directory follows [ADR 0032](../../docs/adr/0032-local-cloudflare-containers-compatibility.md).
It is intentionally outside the application image build context and the root pnpm
workspace. The separate lockfile pins only the local emulator toolchain.

First build and verify the `weletic-cloudflare-local:shopify-runtime-verified` image using
the [container probes](../cloudflare-local/README.md). Then, from repository root:

```sh
pnpm --dir infra/cloudflare-emulator install --ignore-workspace --frozen-lockfile
node --test infra/cloudflare-emulator/process-group.test.mjs
node infra/cloudflare-emulator/local.mjs
```

The launcher accepts no extra arguments and runs only `wrangler dev --local` on
`127.0.0.1:8794`. Test `GET http://127.0.0.1:8794/probe`; all other methods/paths
return 404 without creating a container. The fixed inner request has no caller
cookies, credentials, headers or body. The container disables internet access.

The launcher creates temporary HOME/config/state directories rather than loading
saved Cloudflare authentication. It disables dotenv loading and telemetry, uses
no remote bindings/account ID/routes, and requires a local Unix Docker socket.
On macOS, its empty-auth Docker configuration locates Docker Desktop's bundled
CLI plugins. It does not change the user's Docker configuration. The generated
Wrangler migration entry applies only to local emulator state; it is not a
database schema application or authorization to deploy a Durable Object.

Stop with Ctrl-C. The launcher sends SIGTERM to the child process group and
retains a bounded SIGKILL fallback if descendants survive wrapper exit. Each run
uses a random name. After the process group exits, cleanup validates the exact
run-specific application/proxy names and full Docker IDs, stops only those IDs,
and checks that none remain running. Unexpected inventory or Docker failures
make cleanup fail visibly. Inspect the run's IDs before and after verification;
never stop unrelated containers or use broad Docker prune commands. Temporary
state is retained for diagnosis, not silently deleted.

No `deploy`, image upload, login or remote execution command is provided or
authorized. A successful local probe would prove local routing/startup only,
not external HTTPS, installed public identity, real jobs, database compatibility,
Shopify journeys, pricing or production readiness.

Sources: [Cloudflare local development](https://developers.cloudflare.com/containers/guides/local-dev/),
[Container configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).
