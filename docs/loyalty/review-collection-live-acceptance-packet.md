# Review collection — proposed live acceptance packet

Updated September 23, 2026. **Not approved, not executed.** This packet covers
R01/R02 collection, reminders and delivery history only. It cannot close all
Reviews, incentive fulfillment, production or Cloudflare gates.

## Preconditions and stop conditions

- Collection/reminder implementation must be committed, independently reviewed,
  merged with successful CI and deployed to the approved local acceptance runtime.
  The current draft is not that candidate. Record its exact eventual commit.
- The approved policy is one shared store/email budget across Loyalty and Reviews,
  including anonymous confirmations and later authenticated messages, with an
  independent customer limit and explicit IANA timezone. Verify the installed
  quiet-hour/frequency controls before live reminder acceptance; local mocks or
  an unconfigured policy do not satisfy this prerequisite.
- Identify the public registration, canonical Shopify store ID, `yamaxdev` alias,
  approved active installation generation and exact isolated database. Compare
  browser, gateway, scheduler and SQL identity before enabling any writer.
- Inventory actual columns/indexes and migration history first. The September 20
  activation, delivery-snapshot and collection migrations are prerequisites only
  where absent; never blindly rerun ALTER statements or use `prisma db push` on
  retained data. Include the shared-delivery tables and reminder export phase in
  reader/worker compatibility checks; drain older exports before enabling writers.
  Produce the exact reviewed SQL diff and backup/restore procedure
  for separate scoped schema approval. Do not touch legacy/production databases.
- Confirm a controlled recipient inbox, verified sender, approved provider,
  appropriate recipient consent and private evidence storage. Recipient, signed
  invitation URLs, provider IDs and customer/order identifiers stay out of Git.
- Read and record current collection/module/incentive settings. Inventory queued,
  sending and uncertain jobs first. Existing uncontrolled work is a stop condition,
  not permission to drain a whole queue. Keep marketing and loyalty sends disabled.
- Use store/fixture-bounded dispatch. If the existing worker cannot restrict the
  run safely, implement and test that containment before this live packet starts.
- Stop on foreign-store activity, unexpected recipients, uncertain duplicate
  transport, identity/generation mismatch, accounting changes or exceeded caps.

## Proposed authorization envelope

Present these limits together for explicit approval after prerequisites pass:

| Operation      | Proposed limit and boundary                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store          | `yamaxdev` only; no `weletic.com` mutations                                                                                                                 |
| Orders         | At most two new disposable test orders, one product each, no real payment; any Shopify transactional notifications explicitly included in approval          |
| Recipients     | One explicitly approved operator-controlled mailbox; reuse only after verifying ownership and consent                                                       |
| Review email   | At most three provider submissions: initial A, initial B and one scheduled reminder for B; no uncertain manual resend                                       |
| Content        | Two synthetic, clearly labeled reviews, including one low rating; one safe fixture photo; no personal content                                               |
| Incentives     | Explicit `none` policy for these newly created orders; no points, coupons, automatic enrollment or financial correction in this packet                      |
| Store settings | Snapshot and restore collection settings through revision-fenced gateways; separate recorded approval for temporary module activation if currently disabled |
| Infrastructure | Existing approved isolated local runtime only; no Cloudflare purchase, DNS change, public listing, permanent deployment or uninstall                        |

These are proposed caps, not authority to execute. If prerequisites need more
orders/sends or a different recipient, revise the packet before execution.

## Execution and evidence

1. **Baseline and authorization:** record candidate revision, settings revisions,
   active generation, SQL/schema identity, owned fixture manifest and financial
   baseline in private evidence. Owner/staff-denied, unknown-store and stale-write
   controls must pass without dispatch. Use the real installed embedded app.
2. **Prospective settings:** through the signed editor set `sendAfterDays=0`,
   `expiresAfterDays=3`, `autoPublish=false`, photo uploads on and
   `reminderAfterDays=[1]`, subject to the approved delivery policy. Create orders
   only after activation and fulfill them through the approved Shopify test path.
   Old orders/invitations must not acquire new reminders.
3. **Initial deliveries:** dispatch only requests A/B. Reconcile signed fulfillment
   events, one request per order/product, provider receipts, inbox arrival and
   delivery history separately. A provider receipt alone is not inbox evidence.
   An ambiguous response consumes the cap and stops live retry until reconciled.
4. **Submission A:** open the scoped invitation, inspect disclosed no-incentive
   terms, submit a low-rating text/photo review and repeat the same submission.
   Require one review, no award or enrollment, and no later reminder. Capture
   expired/invalid-token and permission states using approved bounded fixtures;
   never publish usable bearer links or change authentication tolerances.
5. **Reminder B:** leave B unanswered. Wait for the real saved due time: offsets
   are elapsed 24-hour days after confirmed initial delivery, not after fulfillment
   or the prior reminder. Do not edit timestamps or the Mac clock to claim live
   timing acceptance. The shortest valid reminder takes at least one day.
   Verify no early send, one due send, unchanged original expiry, stable immutable
   content and no duplicate from repeated scheduling. Then submit B.
6. **Moderation/display:** verify low rating is not suppressed by eligibility
   rules, perform an explicit authorized publication/reply, and inspect the actual
   draft-theme product summary/widget. No automatic publication is expected from
   this policy. Check EN/JA/VI, 375px, keyboard, loading/error/permission states and
   absence of unintended private identifiers. Record surfaces separately.
7. **Reconciliation:** independently query fixture-scoped requests, reminders,
   outbox jobs, reviews/media and moderation history. Compare accepted request
   count, provider submission count, status/receipt timestamps and projected
   aggregates. Confirm zero incentive claims, ledger deltas and new loyalty
   accounts attributable to these fixtures. Counts alone are not full accounting
   evidence; retain identifiers privately for exact row comparison.
8. **Cleanup:** first stop fixture dispatch and disable affected writers through
   supported controls. Restore settings using the latest revision, not raw SQL.
   Unpublish fixture content, invoke the approved fixture-scoped privacy/media
   cleanup, verify owned objects/tokens/payloads are erased, and contain remaining
   queue intents. Retain minimal audit/provenance and financial history. Do not
   delete unrelated rows or label an uncertain delivery as unsent. Dispose of the
   two Shopify test orders only by the specifically approved cleanup operation.

## Additional gates not proven by this packet

- Real process-death recovery, Redis/SQL lease races, reinstall/stale workers,
  privacy during transport, provider ambiguity and restoration rehearsals need
  their own controlled fault-injection evidence. Existing in-process SQL tests
  with mocked transports do not substitute for these.
- Points/coupon incentive acceptance needs its own bounded financial packet after
  enrollment recovery and activation gates pass. No incentives may be enabled
  merely to exercise collection.
- A local CLI tunnel is not persistent Cloudflare supervision or release proof.
  PR #89 admits existing routes only; collection routes and complete review worker/
  media packaging still require release integration.
- Exact supported suppression, expiry and remaining invitation schedules require
  recorded cases beyond the two happy-path fixtures; do not claim universal
  collection completion from this packet alone.

Report each case as **not run / passed / failed / blocked**, with candidate SHA,
time, private evidence reference, observed state, expected state and cleanup.
Publish only normalized observations. Link results back to R01/R02 and S01/S04/S05
in [the completion checklist](company-store-completion.md).
