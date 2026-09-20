# Owner-granted Flow points action acceptance

Status: implementation draft; no published extension, enabled runtime or live
workflow acceptance is implied. Company stores only. This action is an explicit
manual adjustment, not a second purchase or review incentive writer.

## Configuration and authority

Schema-first rollout is mandatory: rehearse and apply the reviewed additive
`20260920_flow_points_action.sql` to the intended isolated runtime before deploying
this reader. Staff privacy cleanup queries the grant table even when the action
flag is off. Flag-off is not a substitute for schema compatibility. Shared or
production schema application retains its separate approval gate.

- Extension handle: `weletic-adjust-points`. It has no source UID. Select and
  reconcile ownership against the public registration before publication; never
  inherit a custom-app UID.
- The runtime URL is the separate public API host's
  `/api/shopify/flow/points-adjustment`, not the embedded UI host. Reconcile that
  exact HTTPS URL for a local acceptance tunnel before publishing a preview.
- Fields: Shopify `customer_reference` becomes `customer_id`; `grant_id` and
  `points_delta` are required text fields. Points are exact non-zero signed
  64-bit decimal strings, not JSON numbers or formatted currency.
- The owner creates a bounded grant in `/loyalty-flow`: explicit credit/debit
  directions, per-action limit, total absolute budget and future expiry. A debit
  can produce a negative balance. The grant is scoped to the installation and
  does not enroll a shopper or authorize a different store.
- The public backend requires its native public-app credential, paired Shopify
  shop identity, active company-store/program admission and an eligible existing
  account. Requests require the public app's exact-byte Shopify HMAC. A grant ID
  is not a bearer credential or substitute for that signature.
- `WELETIC_SHOPIFY_FLOW_ACTIONS_ENABLED` is disabled unless exactly `1`. The
  backend uses the isolated public app's `SHOPIFY_WEBHOOK_SECRET`, with optional
  `SHOPIFY_WEBHOOK_SECRET_NEXT` for reviewed rotation. Never use the custom app's
  session or secret. Existing ingress pairing verifies the public secret pair.

## Live execution bundle — approval required

Before execution, record public registration, canonical store identity, installation
generation, build/commit, endpoint, isolated runtime and exact disposable customer
fixture. Obtain scoped approval for publication/runtime activation and resulting
test point mutations together; no emails, orders or production writes are implied.

1. Verify fresh owner authentication and denial for a staff member without owner
   authority. Create a small, short-lived credit/debit grant and record its audited
   revision privately. Confirm invalid limits and stale generation cannot create
   authority. Unknown stores remain pending approval.
2. Publish the reviewed public action, select the disposable enrolled customer,
   and run an explicitly bounded manual test workflow. Use `10` for a credit and
   `-4` for a separately approved debit within the grant limits. Record actual
   Shopify run IDs privately and safe evidence names in the acceptance matrix.
3. Independently reconcile ledger deltas, cached balance, grant absolute usage
   (`14` for those two runs), durable run receipts and sync outbox. Confirm no
   purchase lifetime earnings, VIP-entry reward or review incentive was fabricated.
4. Redeliver the same signed run and prove no additional ledger/budget/outbox
   effect. A changed payload using the same run identity must fail, not become a
   new adjustment. Simulate an ambiguous response/crash and reconcile the original
   run before any retry; never change its run ID to bypass deduplication.
5. Verify exact-limit boundaries, exhausted/expired/revoked grants, foreign
   grant/customer IDs, concurrent budget use, privacy tombstones and installation
   replacement. Old-generation credentials/workers must not write. Do not treat
   grant status alone as evidence that the runtime or Flow extension is enabled.
6. Verify an ambiguous owner create/revoke response through signed read-back.
   The same-tab pending journal contains recovery metadata only. Empty recovery
   results are inconclusive; do not submit again. If the browser journal is lost,
   reconcile the scoped server audit/grant history privately before creating any
   replacement authority. Confirmed validation rejection allows explicit correction.
7. Disable the workflow and revoke the test grant after acceptance. Reconcile
   exact fixtures and retain append-only financial/run evidence. Any compensating
   adjustment needs a separately named audited action, not deletion of history.

## Containment and diagnostics

Revoke a grant to stop new authorized effects under that grant. For broader
containment, disable affected workflows and turn off the runtime action flag.
Disabled/unavailable responses can cause Shopify retries: re-enabling without
reviewing pending runs can resume queued effects. Do not assume flag-off cancels
Shopify's queue. Keep run receipts and installation fences throughout recovery.
Already-committed matching replays must remain effect-free.

Report malformed/signature failures, run conflicts and retryable unavailability
without exposing customer IDs, secrets or raw signed bodies. Use private audit
access for investigation. Live queue behavior, latency, Redis lease supervision
and alert delivery still require named acceptance evidence.

## Sources and bounded evidence

[Shopify action fields](https://shopify.dev/docs/apps/build/flow/actions/reference)
define the manifest and text/reference field types.
[Shopify endpoints](https://shopify.dev/docs/apps/build/flow/actions/endpoints)
define the signed payload, run identity and response/retry contract.
The [worklog](flow-points-action-worklog.md) records unit, isolated SQL and
synthetic-browser evidence separately. No local test closes the live gates above.
