# Yamaxdev discounted-order retest — September 18, 2026

Runtime: public main `8b48c08dc742edf872300f16694d055d9baecd96` (PR #77).
Its post-merge Fast Quality Gate passed. This is bounded live evidence, not
full loyalty acceptance or production readiness.

## Scope and prerequisites

- Existing public-app preview on yamaxdev (canonical montdev), isolated local
  SQL/Redis and unpublished App Ext. Host theme. No custom-app or production
  configuration, schema, credential, or authentication-rule change.
- Two additional Bogus Gateway orders, combined JPY 3,190, one redemption and
  refunds, using the previously recorded disposable customer/product/reward.
  Shopify transactional notifications were authorized; marketing remained
  unchecked, and Weletic delivery credentials/workers remained disabled.
- The earlier retry encountered intermittent merchant authentication failures.
  Read-only SNTP measured the Mac 4.22 seconds behind. Hiro synchronized it;
  subsequent checks measured approximately 34–41 milliseconds. Initial merchant
  access, program activation and reward save then succeeded without auth changes.
  This supports the clock diagnosis but does not prove every session transition.
- Baseline: program disabled, two historical orders, one used redemption, cached
  balance -100 and pending 0. Earlier refunded #1042 was not repaired or replayed.

## Named financial evidence

| Step                      | Observed live result                                                                                             | Ledger / balance                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Purchase #1043            | Two JPY 1,000 fixture units, JPY 200 tax, JPY 2,200 total. Shopify Admin confirms Test order and Bogus Gateway.  | EARN_ORDER +2,000; balance 1,900      |
| Fixed redemption          | Native drawer confirmation spends 100 points; wallet shows an available JPY 100 discount.                        | REDEEM_REWARD -100; balance 1,800     |
| Discounted purchase #1044 | One JPY 1,000 unit, JPY 100 discount, JPY 90 tax, JPY 990 total. Native checkout and Admin confirm test payment. | EARN_ORDER +900; balance 2,700        |
| Partial refund #1043      | One unit / JPY 1,100; Admin shows Partially refunded.                                                            | REFUND_REVERSAL -1,000; balance 1,700 |
| Remaining refund #1043    | Remaining unit / JPY 1,100; Admin shows Refunded.                                                                | REFUND_REVERSAL -1,000; balance 700   |
| Full refund #1044         | JPY 990; Admin shows Refunded. Captured merchandise net remains 900 and discount 100.                            | REFUND_REVERSAL -900; balance -200    |

Independent read-only SQL sums all ten historical ledger entries to -200, matching
the account cache; pending sum/cache are 0 and lifetime earned is 4,900. This run
added exactly six entries. Both redemptions remain used: refunding merchandise
does not automatically restore a spent, used reward. No manual balance correction
or snapshot rewrite was performed. Optional refund notifications and restocking
were unchecked on each refund. Inbox delivery is not claimed.

## Webhook completion — not fully accepted

The primary paid and refund deliveries completed. Concurrent duplicate deliveries
hit the existing order lock and failed transiently. One #1043 paid duplicate
subsequently reached processed on attempt 3 with no duplicate earn. At the first
post-refund reconciliation and the final observation before shutdown, a #1044
paid duplicate and a #1043 partial-refund duplicate were still failed awaiting
platform retry. Eight of ten new paid/refund event records were processed;
two retained lock-contention errors. There were no new reconciliation issues.
All financial effects reconciled, but terminal completion of every duplicate is
**not accepted**. A controlled retry/recovery check remains required; no signed
event was fabricated and no failed row was manually marked processed.

## Shopper refresh and cleanup

The post-refund drawer initially reported a temporarily unavailable balance.
Its explicit Refresh balance action recovered and displayed -200 points, no
available coupons and both rewards as Used, with the new reward linked to #1044.
This is successful recovery evidence, not a clean first-load pass on every page.

Signed merchant UI and independent SQL confirm the program disabled and reward
inactive. Shopify Admin confirms the exact disposable product archived again.
The public launcher is disabled and saved on the draft theme; the custom embed
remains disabled and the theme was not published. Financial history and the
existing disposable customer are retained. CLI, tunnels, backend and ingress were
stopped after the final observation; the isolated VM was shut down preserving
volumes. This also ends live retry reception until the preview is deliberately
restarted. No permanent deletion, stored-value issuance, real charge, deployment,
or app uninstall occurred.

## Remaining scope

The [acceptance matrix](unified-acceptance-matrix.md) remains authoritative.
This run does not close subscriptions, other reward types, VIP, campaigns,
referrals, communications delivery, analytics/export reconciliation, maximum-size
imports, multilingual/accessibility coverage, Flow, installed account extensions,
reinstall/generation tests, worker supervision, Cloudflare or weletic.com rollout.
The previous #1042 reconciliation issue remains historical evidence, not a newly
accepted order or permission for repair.
