# Local runtime smoke checks — September 10, 2026

Hiro explicitly approved loopback-only startup on ports 8890 and 3002 for smoke
tests, with workers disabled and no public exposure or Shopify business activity.
Application source: PR #15 at `b775ae470c9c2f5a37498fbc1e331202fd707b25`.
All six public CI checks passed for that source in run 34430356509.

## Scope and isolation

The reviewed runtime policy loaded the existing private isolated credentials
without copying or modifying them. Sixteen configuration checks passed, including
separate app/service/encryption/session/cron secrets, local resource targets and
disabled email/scheduler delivery. The execution checkout contained no retained
dotenv overlays. Retained environment files were used only for comparison.

Direct Next.js and Remix executables ran the current PR checkout. No generic dev
script, Shopify CLI linking, tunnel, scheduler, sync poller or worker was started.
This smoke invocation omitted the separate mutating Redis/media probe suite;
resource-container bindings were inspected read-only. The five isolated service
containers remained in their existing configuration.

`lsof` confirmed the applications listened only at `127.0.0.1:8890` and
`127.0.0.1:3002`. This is process/configuration isolation, not an egress firewall.

## Results

| Probe                                                                | Observed result                                                            |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Unsigned web session GET                                             | 401                                                                        |
| Unsigned Shopify internal GET                                        | 401                                                                        |
| Unsigned outbox cron GET                                             | 401, before worker execution                                               |
| Unsigned outbox cron POST                                            | 400, missing signature, before worker execution                            |
| Foreign Host on Shopify internal route                               | 403                                                                        |
| Existing production HMAC client reading a random nonexistent session | 200, empty session array                                                   |
| Login with local app Host                                            | 200 HTML with sign-in title and no Plausible initialization/script markers |

All seven checks passed. No authentication was bypassed, no user/store/session
was created, and no real customer/order/reward was used. Independent SQL counts
across all 159 base tables returned no populated tables during the smoke run.
These are local HTTP checks, not browser accessibility or live Shopify acceptance.

## Cleanup and remaining gates

SIGTERM stopped both temporary application launchers and their listeners after
the probes. Ports 8890 and 3002 were verified free. The Shopify launcher reported
exit 143 on deliberate termination; this was cleanup after successful checks,
not a failed smoke assertion. Credentials, databases and service volumes remain.

No DNS/public routing, deployment, installation, authenticated worker execution,
loyalty activation, order, redemption, refund, email or production change occurred.
Frozen import work remains untouched. Public-app configuration and extension
ownership, real install/reinstall, and named yamaxdev lifecycle proof remain open.
