# Public runtime policy — September 10, 2026

Implements the startup portion of ADR 0029. This is not public deployment or
`yamaxdev` installation/loyalty acceptance evidence.

## Enforced behavior

- The public client ID or either reserved public endpoint selects strict policy.
- Shopify SDK initialization and each internal gateway request reject mismatched
  identity, distribution, required scopes or paired endpoints before sending work.
- Public required scopes cannot fall back to custom defaults or include optional
  stored-value permissions. Actual granted permissions remain a separate check.
- HTTPS accepts only the reviewed app/backend origin pair. Loopback accepts only
  explicit isolated development on the reviewed origins and Shopify port 3002.
- App and signing secrets must meet minimum length and be distinct after the same
  trimming used by the runtime credential loader. Failure messages expose no values.
- The custom manifest and legacy runtime fallback remain unchanged.
- The isolated initializer, preflight and launcher share the seven-scope inventory.

## Local environment action

Only the `SCOPES` line in the private isolated Shopify environment file was narrowed
to the approved required list. No credentials were created, changed or rotated;
the file remains mode 0600. All 16 read-only four-file configuration checks passed.
Building both paired launch environments and applying the public Shopify policy to
the resulting Shopify environment also passed, without starting either app.

The private retained/custom files, database/schema, Redis, media and all external
Shopify state were untouched by this step. Ports 8890 and 3002 had no listeners
before the private configuration edit.

## Verification

- Focused runtime/configuration suites: 94 tests passed across four files.
- Actual gateway function with synthetic transport: an incorrect backend is rejected
  before `fetch`. These are not live Shopify requests.
- Independent review identified a raw-versus-trimmed credential comparison issue;
  fixed with whitespace and padded-duplicate regression cases and re-reviewed.
- Repeated the previously approved bounded loopback HTTP smoke on this runtime
  policy: all seven probes passed, including the signed empty-session read and
  unsigned/foreign-host rejection. No Shopify customer authentication was attempted.
- Independent SQL counts during the smoke found all 159 base tables empty.
- Frozen full regression: 395 files passed; 6,054 tests passed and six skipped
  (530.54 seconds). The earlier mixed-source run's one whitespace-scope failure
  is superseded by this clean rerun, not waived.
- Web/Shopify typechecks, root lint, changed-file formatting, 32 Shopify package
  tests and the final Shopify production build passed. Existing nonfatal framework
  and source-map warnings remain. Fresh public CI is still required for this commit.
- Frozen policy SHA-256:
  `b3fedb7595d17a1446c2dc8fa4c2a05353bfccb4dbf8a972afb9544b772e4e69`;
  runtime test SHA-256:
  `af327e624cb1b1288fdcb9de2e7d5d2dee457fd073c29e4dd0ae6d0acc2d749f`.

## Remaining public environment gates

This policy protects the Shopify process, not a standalone backend deployment.
The current paired launcher remains loopback-only and retains its namespace/secret
comparison preflight. An HTTPS deployment must enforce paired backend database,
Redis, media, session, queue and secret isolation, webhook routing, middleware host
behavior and supervision before exposure. The temporary loopback processes were
stopped after verification. No tunnel, DNS change, deployment, installation,
activation, order, redemption or email occurred here.

Public extension identity reconciliation and the named first-install/reinstall
and core lifecycle acceptance remain outstanding. The configuration-only manifest
continues to disable extension discovery.

### Backend routing follow-up confirmed by source inspection

Historical finding at `6f1c1c2668`; the subsequent
[webhook routing receipt](public-webhook-validation-2026-09-10.md) records the fix.
All six public CI checks for `6f1c1c2668` passed in
[run 34441119322](https://github.com/satoshicancode/weletic-room-public/actions/runs/34441119322).

`apps/web/lib/weletic/shopify/provision-webhooks.ts` currently resolves an explicit
argument, then `DEV_WEBHOOK_URL`, then the legacy development fallback, then the
app domain. It does not read `SHOPIFY_WEBHOOK_URL`, despite that variable being
validated by the isolated preflight. `catalog-sync.ts`, the legacy session
activation branch and the installation-generation activation script call the
provisioner without an explicit callback URL.

Before public activation, enforce the approved public callback path and origin in
the provisioning boundary, with no fallback to the retained app. Cover both normal
and segment webhook provisioning, invalid/absent/legacy overrides, refusal before
GraphQL dispatch, and unchanged legacy behavior. Loopback-only verification must
not be mistaken for permission to register a publicly reachable callback.

The [extension reconciliation inventory](public-extension-reconciliation-2026-09-10.md)
separately identifies UI and Flow callback origins that still reference the custom
app and require isolated public staging.
