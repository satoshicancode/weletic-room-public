# Yamaxdev live shopper checkpoint — September 18, 2026

Result: **partial live acceptance; not a completed financial journey**. This
supersedes the no-order state in the September 17 checkpoint, not the broader
acceptance matrix. Observations occurred around 00:05–00:35 JST.

## Scope and identity

Hiro approved two test-mode orders and their Shopify transactional notifications.
Marketing and Weletic loyalty delivery stayed disabled. Native customer sign-in
was completed by Hiro; no synthetic App Proxy identity or Admin-token shopper
session was used. Tests used the existing public app development preview on
yamaxdev (canonical domain montdev), isolated local SQL/Redis, and the draft
App Ext. Host theme. No production deployment, theme publication, real charge,
custom-app change, or third order occurred.

## Named live evidence

| Check                      | Observed result                                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purchase                   | Shopify order #1041: two fixture units at JPY 1,000, JPY 200 tax, total JPY 2,200. Admin explicitly identified Test order and Bogus Gateway.                         |
| Earning                    | One EARN_ORDER entry +2,000, pending 0. The authenticated drawer showed 2,000 available points. Duplicate deliveries did not duplicate this earn.                    |
| Redemption                 | The fixed fixture reward cost 100 points and issued a native JPY 100 discount. Drawer confirmation, available wallet entry and REDEEM_REWARD -100 were observed.     |
| Checkout use               | Shopify order #1042: one JPY 1,000 unit, JPY 100 reward discount, JPY 90 tax, total JPY 990. Checkout and Admin confirmed the test payment. Redemption became used.  |
| Partial refund             | #1041: one unit refunded for JPY 1,100; Shopify showed Partially refunded. Ledger REFUND_REVERSAL -1,000, balance 900.                                               |
| Remaining refund           | #1041: remaining unit refunded for JPY 1,100; Shopify showed Refunded. A second REFUND_REVERSAL -1,000 left balance -100.                                            |
| Second-order cleanup       | #1042 fully refunded for JPY 990; Shopify and local commerce projection both showed refunded. No points were fabricated for its blocked earn.                        |
| Independent reconciliation | Read-only SQL: ledger sum -100 equals cached balance -100; pending 0; lifetime earned 2,000. Four ledger entries: +2,000, -100, -1,000, -1,000. Reward remains used. |

Shopify's order-confirmation notification was observed in the timeline. Optional
refund notifications were unchecked. Neither inbox delivery nor loyalty email
delivery is claimed. Negative balance after refunding spent points was retained;
no manual correction or deletion of financial history was performed.

## Blocking defects and next implementation tasks

### Discount allocation capture

Order #1042 did not earn points. The guard raised
`loyalty_order_line_snapshot_unavailable` with reason
`order_line_net_does_not_match_order_net`: captured line net 1,000 versus order
net 900. The earning rule had `excludeDiscountedItems=false` and no per-customer
event limit. This is not evidence that discounted orders should be excluded.

`apps/web/lib/weletic/commerce/record-order.ts` currently calculates line discount
from `total_discount_set`; native order-level discount allocations need explicit
reconciliation. Implement exact shop/presentment allocation capture using
verified Shopify payload semantics, with zero-decimal currency, multiple lines,
multiple allocations, missing/contradictory values, replay and refund tests.
Preserve fail-closed arithmetic and immutable existing snapshots. Repair/replay of
the already-refunded fixture needs a separately reviewed containment procedure;
do not overwrite history or silently backfill its original earn.

### Affiliate queue coupling

Paid-order webhooks completed loyalty stages but then attempted the affiliate
QStash path in the loyalty-only isolated runtime. The intentionally absent queue
credential caused `unable to authenticate: invalid token`, leaving failed events
and retries. Duplicate concurrent events also recorded order-lock contention.
Define and test the no-affiliate branch without weakening configured affiliate
processing, webhook authenticity, retry semantics or installation fencing. Do not
solve this by adding production credentials to the isolated preview. A full pass
requires webhook completion, not merely a successful ledger side effect.

### Remaining acceptance

Discounted earning/reconciliation, reward restoration policy after use/refund,
successful webhook terminal states, and the broader lifecycle matrix remain open.
This run does not prove subscription, VIP, campaign, referral, multilingual,
accessibility, all reward types, production delivery, or deployed worker behavior.

## Cleanup and retained evidence

- Program `loyalty-acceptance-20260917-a`: disabled through the signed merchant
  editor; independent SQL verified disabled.
- Reward `loyalty-acceptance-20260917-a-fixed`: paused through the signed editor;
  SQL verified inactive. Its used redemption and audit history remain intact.
- Exact disposable product `loyalty-acceptance-20260917-a-product`: archived,
  recoverable through Shopify. Orders and customer retained for audit.
- Public launcher disabled and saved on the draft theme; custom embed unchanged.
- Both test orders fully refunded with no inventory restocking. No permanent
  deletion, store-credit issuance, real charge or app uninstall occurred.
- CLI preview, both temporary tunnels, backend and ingress were stopped after
  cleanup. Isolated VM shutdown preserves its database volume for investigation.

No customer email, auth code, signed preview URL, coupon code, credentials or
copied Shopify assets are included in this public-safe evidence record.
