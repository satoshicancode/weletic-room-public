# Store-review acceptance packet

Status: implementation preparation, September 23, 2026. Not live execution
approval and not a completed Reviews release gate.

## Required before scheduling yamaxdev execution

1. Complete the signed customer/merchant gateways, settings, prospective
   collection/reminders and EN/JA/VI interfaces. The current internal services
   cannot establish installed authentication or delivery acceptance by themselves.
2. Complete prospective collector integration and installed acceptance of the
   locally verified signed controls for the shared policy (ADRs 0042/0043).
   Anonymous and authenticated messages share email
   capacity; customer limits also apply. Never infer timezone from locale/currency
   or schedule historical invitations automatically.
3. Review and explicitly approve the target migration/runtime bundle. All five
   tables in `20260922_store_review_core.sql` must exist before deploying these
   privacy readers, even with collection disabled. Retain a compatible worker
   for persisted `export_store_reviews`, `export_store_review_requests` and
   `export_store_review_audits` phases. Do not roll workers back to an incompatible
   binary or remove tables while export/privacy work remains. Also apply the two
   delivery tables, settings JSON and appended job enum in
   `20260923_shopper_delivery_budget.sql`. Retain workers for
   `export_shopper_delivery`, `scrub_customer_delivery`, `purge_shopper_delivery`
   and `ANONYMOUS_REFERRAL_EMAIL`. Drain/reconcile old exports without saved
   delivery identities and uncertain sends without a matching reservation.
4. Identify the installation generation, staff identities/permissions, controlled
   shopper/recipient, provider connection, eligible test orders and exact spend /
   live-send limits. Obtain the existing scoped live-order/send approval.

## Named acceptance journeys

| Journey                              | Evidence required                                                                                                                                                                                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR-01: store feedback                | Authenticated controlled shopper submits low-rating feedback for an eligible owned invitation in EN/JA/VI; exact uncertain-response retry creates one record. Changed content, expired first submission, foreign store/shopper and stale generation fail.                                    |
| SR-02: order-wide points promise     | Product and store submissions compete on one eligible order. Independent SQL finds one immutable claim and one exact points award. Later refunds, publication changes and replay do not duplicate or revoke the promise.                                                                     |
| SR-03: order-wide coupon promise     | Reviews-only shopper receives the original coupon without Loyalty enrollment. Provider identity/configuration matches the promise. Ambiguous response recovery adopts that identity; it does not create a replacement.                                                                       |
| SR-04: moderation and public summary | Authorized staff publish, reply and hide with version checks and audit evidence. Unauthorized staff are denied. Public rows and totals apply the same privacy predicate. Ratings do not change award eligibility.                                                                            |
| SR-05: collection and reminders      | New qualifying fulfillment creates only the prospective invitation(s). Shared order policy remains fixed. Actual provider submission, delivery history and controlled inbox arrival are recorded separately. Historical orders remain unsent.                                                |
| SR-06: privacy and recovery          | Erasure wins safely against submission/fulfillment. Content, replies, delivery envelopes and identity projections are suppressed; provider cleanup completes. Winning encrypted exports resume after interruption without page loss or token leakage. Financial history remains append-only. |
| SR-07: installed UI and operations   | 375px layouts, keyboard navigation, EN/JA/VI, loading/failure/retry states; installed ownership/grants, process restart, supervision, alerts and restore evidence.                                                                                                                           |

Shared-delivery acceptance must also prove: an anonymous confirmation consumes
capacity for a later authenticated message to the same mailbox; distinct customers
sharing that mailbox share capacity without sharing export access; changing an
email does not reset the customer limit; quiet hours use the configured timezone;
policy deferral preserves worker attempts; retries retain bytes and deadlines;
and privacy erasure/worker restart do not restore deleted recipient evidence.
Run these only after the policy controls are installed and the controlled
recipients and live-send limits are approved. Verify that a policy save preserves
prior capacity, cannot clear its timezone alone, and never activates modules or
creates historical invitations.

Record each journey with date, application commit/image, installation generation,
controlled object IDs, expected/actual result, independent evidence location and
cleanup outcome. Local SQL/mocked provider tests support implementation review;
they do not close any installed/provider/operational acceptance row.

## Containment

Disable new collection first. Preserve queued financial promises, provider
reconciliation records and compatible compliance workers. Never classify ordinary
privacy erasure, criticism or refunds as confirmed incentive fraud. Retain existing
apps until retirement is explicitly approved.
