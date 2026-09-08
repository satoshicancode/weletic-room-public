# Isolated application runtime

Scope: package 1, local startup and service-authentication evidence. This does
not establish Shopify installation, merchant permissions, token-refresh safety,
webhook delivery, Flow publication, or loyalty/review acceptance.

## Start and verify

Use Node 24 and the separate `weletic-room-loyalty-dev` checkout after completing
the [isolated service setup](./local-services.md). Build workspace dependencies
with `pnpm build:packages` before startup. Start each application in its own
terminal, using the retained files only for read-only comparison:

```sh
node infra/shopify-development/run.mjs --app=web --retained-web=/absolute/retained/apps/web/.env --retained-shopify=/absolute/retained/packages/shopify-app/.env --confirm-local-runtime
node infra/shopify-development/run.mjs --app=shopify --retained-web=/absolute/retained/apps/web/.env --retained-shopify=/absolute/retained/packages/shopify-app/.env --confirm-local-runtime
node infra/shopify-development/verify-runtime.mjs --confirm-local-runtime-probes
```

Both launches repeat the four-file configuration comparison and live local
service probes. Those service probes create/remove bounded synthetic Redis/S3
objects as documented previously; they do not create merchant data. The
runtime verifier makes unsigned rejection requests and one production-client
HMAC-signed **GET** for a random nonexistent session. It does not authenticate a
cron, install a shop, send an email, or store/delete a session.

The launcher:

- Loads only the two private `.env.loyalty.local` files; rejects default dotenv
  overlays, reused retained files, unsafe targets and nonempty unreviewed keys.
- Scrubs inherited application secrets, Node preloads, delivery providers,
  global Redis credentials and URL overrides. Retains only basic OS facilities.
- Uses direct framework executables, loopback-only web `8890` / Shopify `3002`,
  and refuses occupied ports instead of silently switching ports. No generic
  dev hooks, app linking, tunnel, migration, scheduler or sync poller.
- Pins app/API/admin/partner origins to port `8890`; shared API configuration
  remains optional and retains existing defaults elsewhere.
- Uses the checkout's ignored `.next-dev` output. It disables Plausible script
  rendering and enables Next.js 15's
  [original-URL middleware mode](https://nextjs.org/docs/15/app/api-reference/file-conventions/middleware#advanced-middleware-flags)
  only for this isolated environment. Live testing found normalized localhost
  rewrites otherwise re-entered link routing instead of rendering login.
- Restricts the isolated Vite server's allowed hosts. Configured credentials
  are redacted from complete output lines, including credentials split across
  chunks; oversized lines are omitted. This is not universal PII redaction.

Stop each launcher with Ctrl-C or SIGTERM; it forwards termination to its child.
Keep ignored credentials, generated dependencies and Docker volumes for resume.
Do not stop the retained listeners on `8888`/`3000` or delete their resources.

## Boundaries

This is configuration/process isolation, **not an OS sandbox or egress firewall**.
Existing authentication routes still exist. No installation or external delivery
was activated; absence of a tunnel is not an authorization control. Do not expose
these listeners, copy delivery credentials, log in through Shopify installation,
or invoke authenticated workers until the corresponding approval and release
gates are satisfied. Preserve `n0pvef-cs` and the competitor installations/trials.

## Local evidence — 2026-09-06

Both real applications started against the isolated services. Runtime probes:

All seven runtime checks passed. Independent `COUNT(*)` queries after the probes
found all 141 database tables still empty. A second launch against occupied port
3002 was refused without moving to another port. Sixteen regression tests cover
environment poisoning, fixed targets, configuration compatibility and log redaction.
After verification, SIGTERM stopped both isolated listeners and freed ports 8890
and 3002; retained listeners on 8888 and 3000 remained running. Credentials and
service volumes were preserved for resume.

| Probe                              | Required observation                       |
| ---------------------------------- | ------------------------------------------ |
| Unsigned web session read          | 401                                        |
| Unsigned Shopify internal endpoint | 401                                        |
| Unsigned cron GET / POST           | 401 / 400                                  |
| Foreign Shopify Host               | 403                                        |
| Production signed session client   | Successful empty-session response          |
| Web login rendering                | 200 HTML, no Plausible script/init markers |

This is local evidence only, before installation. The next package-1 work remains
offline-token concurrency fencing/renewal/reconnect handling, then approved public
endpoints, canonical-shop verification and real install/reinstall/webhook/worker
round trips on `yamaxdev`.
