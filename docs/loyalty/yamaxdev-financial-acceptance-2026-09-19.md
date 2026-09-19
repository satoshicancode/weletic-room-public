# Yamaxdev financial acceptance — September 19, 2026

Runtime: public main `1bb504d2d675eb2f3c2834af75973572e9367953` (PR #82).
Its six post-merge CI jobs passed. This report records a bounded live test, not
full loyalty completion or production readiness.

## Authorized scope and baseline

Hiro approved two additional Bogus Gateway orders with a combined JPY 3,190 cap,
one 100-point redemption and partial/full refunds. Shopify transactional order
notifications were allowed; marketing opt-in, Weletic delivery and optional refund
notifications remained disabled. No real payment, production deployment, stale
subscription deletion or historical financial repair was authorized or performed.

The isolated retained SQL/Redis runtime started from ten ledger entries totaling
-200 points, zero pending points and a disabled program. Nine historical failed
financial events were preserved. Public-app identity and canonical
`montdev.myshopify.com` (yamaxdev) were verified through native SDK authentication
and a read-only currentAppInstallation query. The seven required scopes were
unchanged. All 48 old shop-scoped subscriptions remained untouched.

The draft App Ext. Host theme alone used the public loyalty launcher; the legacy
custom-app embed remained disabled. The existing disposable product, program,
customer and fixed reward were reused. No new fixture customer was created.

## Named financial results

| Step                   | Shopify evidence                                                                | Ledger effect | Balance |
| ---------------------- | ------------------------------------------------------------------------------- | ------------: | ------: |
| Purchase #1045         | Two JPY 1,000 units, JPY 200 tax, JPY 2,200 Bogus Gateway payment               |        +2,000 |   1,800 |
| Fixed redemption       | Drawer confirmation; JPY 100 native discount issued to wallet                   |          -100 |   1,700 |
| Purchase #1046         | One JPY 1,000 unit, JPY 100 discount, JPY 90 tax, JPY 990 Bogus Gateway payment |          +900 |   2,600 |
| Partial refund #1045   | One unit, JPY 1,100; Partially refunded                                         |        -1,000 |   1,600 |
| Remaining refund #1045 | Remaining JPY 1,100; Refunded, net payment zero                                 |        -1,000 |     600 |
| Full refund #1046      | JPY 990; Refunded, net payment zero                                             |          -900 |    -300 |

Independent SQL summed all sixteen ledger entries to -300, matching the account
cache. Pending points remained zero; lifetime points earned was 7,800. This run
created exactly six ledger entries and no new reconciliation issue. The final
drawer loaded -300 available points, no available coupons, and the new reward
as Used against #1046. Refunding merchandise did not restore spent reward points.

## Webhook evidence and its limits

All five new financial events completed on attempt 1, with actual signed Shopify
delivery. Completion times below are UTC on September 19 (JST is UTC +9).

| Event                  | Completed UTC |
| ---------------------- | ------------- |
| #1045 paid             | 09:25:10.301  |
| #1046 paid             | 09:29:01.075  |
| #1045 partial refund   | 09:29:59.795  |
| #1045 remaining refund | 09:31:28.800  |
| #1046 full refund      | 09:32:03.437  |

Shopify did not produce concurrent financial duplicates during this run. Therefore
this proves terminal processing of the observed primary events, **not financial
duplicate/recovery acceptance**. No signed event was fabricated, failed historical
event replayed or terminal status manually changed. Product-change retries did
exercise the catalog path, but are not substitutes for financial duplicate tests.

## Operational observations

Initial cold-start authentication timed out; the normal installation recovery
screen and Open app action refreshed the offline session without changing auth
rules. Reward loading also needed its explicit Reload action. The first attempt
to disable the program returned an uncertain result; authoritative UI/SQL reload
confirmed it was still active before retrying. These are recovery observations,
not a claim of uniformly clean merchant first-load/save behavior.

The existing remote API-log sink still rejected ingestion as unauthorized.
Independent SQL, local request logs and Shopify Admin supplied the evidence;
remote log delivery and email inbox delivery are not accepted by this report.

## Cleanup verification

Signed merchant UI and independent SQL confirmed the program disabled and reward
inactive. The draft theme saved with both public and custom launcher embeds off;
it was not published. Shopify Admin and the normal catalog sync confirmed the
fixture archived with empty tags and its original JPY 1,000 price unchanged.
All twelve new observed event rows were processed before shutdown, including the
cleanup product event. The nine old failed financial rows and attempts were
unchanged. No historical status, balance or financial snapshot was rewritten.

The CLI preview, tunnels, backend, ingress, five isolated containers and dedicated
VM were stopped after verification, preserving volumes. No project preview ports
remained listening. No app was uninstalled and no theme was published.

## Remaining acceptance

Historical failed-event recovery and stale-subscription cleanup remain separately
gated. Financial duplicate/replay acceptance, other reward types, subscriptions,
VIP, campaigns, referrals, communications, analytics, imports, multilingual and
accessibility coverage, public release and production rollout remain governed by
the [acceptance matrix](unified-acceptance-matrix.md).

References: [previous financial retest](yamaxdev-discount-retest-2026-09-18.md),
[catalog retry fix](local-catalog-webhook-completion-2026-09-18.md).
