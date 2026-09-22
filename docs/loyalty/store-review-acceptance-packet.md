# Store-review acceptance packet

Status: implementation preparation, September 22, 2026. Not live execution
approval and not a completed Reviews release gate.

## Required before scheduling yamaxdev execution

1. Complete the signed customer/merchant gateways, settings, prospective
   collection/reminders and EN/JA/VI interfaces. The current internal services
   cannot establish installed authentication or delivery acceptance by themselves.
2. Resolve the shared versus per-module communication quiet-hours/frequency
   policy recorded in the collection worklog. Never derive timezone from locale
   or currency, and never schedule historical invitations automatically.
3. Review and explicitly approve the target migration/runtime bundle. All five
   tables in `20260922_store_review_core.sql` must exist before deploying these
   privacy readers, even with collection disabled. Retain a compatible worker
   for persisted `export_store_reviews`, `export_store_review_requests` and
   `export_store_review_audits` phases. Do not roll workers back to an incompatible
   binary or remove tables while export/privacy work remains.
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

Record each journey with date, application commit/image, installation generation,
controlled object IDs, expected/actual result, independent evidence location and
cleanup outcome. Local SQL/mocked provider tests support implementation review;
they do not close any installed/provider/operational acceptance row.

## Containment

Disable new collection first. Preserve queued financial promises, provider
reconciliation records and compatible compliance workers. Never classify ordinary
privacy erasure, criticism or refunds as confirmed incentive fraud. Retain existing
apps until retirement is explicitly approved.
