# Shared loyalty reward catalog

Status: implemented with local service, MySQL and synthetic browser evidence;
release CI and live Shopify acceptance are separate gates.

This loyalty-only increment follows the merge of participation PR #83 and
audited moderation PR #78. Further reviews features are deferred.

## Scope

- Browser-safe, exact reward contracts and projections under
  `apps/web/lib/weletic/loyalty`; reuse the existing reward-definition writer.
- Shared Shopify/workspace catalog editor and thin authenticated gateways under
  the existing merchant API and UI boundaries. Preserve legacy routes during
  the transition; do not broaden Shopify staff permissions.
- Generation fencing, catalog fingerprints, explicit stale-save recovery and
  transaction-local authorization. Reads never initialize or activate a program.
- Existing online reward types only. Keep financial checkout limitations visible;
  configuration is not proof of gift-card or store-credit checkout settlement.

No migration, provider call, store configuration activation, or external send is
part of this increment. Subscription purchase-type persistence, policy snapshots
and provisioning remain a separate schema-validated increment; do not expose an
unconnected subscription selector. POS and further reviews remain deferred.

## Contracts and verification

Use decimal strings for points and money, bounded by existing BigInt/Decimal
columns. Validate resource scopes, canonical identifiers, list limits and
incremental step/minimum/maximum relationships before writes. Unsupported legacy
configurations must be visible but not silently reinterpreted by the new editor.
Reward edits do not rewrite issued redemption snapshots or financial history.

The existing product reward is a capped product/variant discount, not a guaranteed
free item. Incremental amount-off rewards retain their supported monetary cap.
Financial artifacts have no configurable coupon-use limits: their unused fields
must be neutral (`usageLimit: null`, `usageLimitPerCustomer: 0`) and hidden from
the editor, not presented as enforcement. New expiry input is bounded to 36,500
days to avoid invalid date arithmetic; null means no configured expiry. Existing
out-of-contract economic terms are read-only, not rewritten. A separately typed,
confirmed status-only operation can pause/archive those records without changing
terms or issued artifacts. It cannot reactivate or unarchive them. An unavailable
shop currency blocks economic edits but not containment.

The shared editor's synchronous mutation lock survives scope and transport changes;
stale completions cannot populate another visit. An uncertain response is never
automatically retried. Reload is explicit. The duplicate workspace reward modal
was removed after its only caller moved to the shared editor; legacy HTTP APIs
and reward data consumed by the other loyalty tabs remain intact.

Test parser boundaries, legacy projections, scoped permissions, stale generations,
concurrent saves, rollback, customer-bound fulfillment preservation and uncertain
responses. Use actual isolated MySQL transaction tests for concurrency, and
separately label mocked UI tests. Run types, lint, formatting, complete tests and
release CI with adversarial review before merging. Live acceptance on `yamaxdev`
remains separately evidenced; preserve the benchmark store unchanged.

## Local evidence — 2026-09-08

- Full web unit run: 343 files, 5,355 passed, six skipped. Subsequent targeted
  catalog run: 119 passed, including 15 rendered screen tests with null-currency
  containment. The full run preceded these final additive test cases.
- Isolated MySQL staff suite: 54 passed, including signed/workspace catalog
  authority, stale revisions, competing saves, rollback and exact preservation of
  legacy economic columns during containment. These are outcome-based concurrent
  save tests, not an observed-lock containment-versus-save proof.
- Existing review-inbox read fixture now supplies its required shopper/request
  parents. The intentionally cross-store product fixture is retained. This fixes
  invalid test data exposed by participation's required request projection; no
  review production behavior was changed.
- Web/Shopify types, root lint (10 tasks), repository Prettier check, Prisma
  validation, Shopify build and 24 authenticated Shopify bootstrap tests passed.
- Guarded local Next.js compile-mode build passed against isolated development
  configuration; full generation/browser release validation remains a CI gate.
- Seven historical CLI validators ran in `NODE_ENV=test --mock`: expiry,
  referrals, VIP, earning actions, Flow/ESP, financial rewards and campaigns.
  These are simulated evidence, not live provider delivery or checkout proof.
- Playwright CLI used the actual shared editor and Shopify client with an
  in-memory transport restricted to loopback. It saved an inactive synthetic
  reward with point cost `9007199254740993` unchanged, switched English/Japanese/
  Vietnamese, and visually checked 375-pixel mobile renders. Vietnamese content
  width was 375 pixels (no horizontal overflow). This is not installed-store,
  authentication, redemption, keyboard-audit or live accessibility acceptance.
- Adversarial reviewer found no remaining concrete blocker in containment,
  currency gating or scope-change mutation locking.

The dated [Smile reference capture](benchmark-smile-2026-09-08.md) preserves paid
UI observations before trial expiry. It does not claim execution parity.
