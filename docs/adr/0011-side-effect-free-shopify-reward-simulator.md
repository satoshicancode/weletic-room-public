# ADR 0011: Side-effect-free Shopify reward simulator

- Date: 2026-08-23
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Merchants configuring Shopify eCommerce Rewards need to understand which
commission rule applies to each cart line before publishing a configuration.
The progressive condition editor makes Variant → Product → Collection → All
products precedence visible, but a mixed cart can still be misread as receiving
one order-wide percentage. Subscription eligibility and New, Returning, or
Shopify Segment customer rates add further combinations that are difficult to
verify by reading condition sentences alone.

Testing through real Shopify orders would create commerce, attribution, and
commission records and would be too slow and destructive for iterative reward
configuration. A separate browser-only formula would be faster, but it could
drift from the production resolver and money-rounding rules.

## Decision

Add a side-effect-free “Test this reward” simulator to the dedicated Shopify
reward editor. It evaluates the current unsaved form configuration, sample
Shopify catalog variants, editable commissionable prices and quantities,
customer classification, and subscription cycle. The result shows the matched
Variant, Product, Collection, Base, or subscription-exclusion rule and the
commission for every line, followed by the cart total.

The simulator must reuse `resolveShopifyEcommerceCommission` and the production
integer minor-unit allocation behavior. It performs no order, commission,
payout, or reward writes. Draft and scheduled configurations remain testable by
normalizing activation only inside the preview projection; this does not change
the saved lifecycle.

## Alternatives considered

- **Create real Shopify test orders** — Rejected because it is slow, depends on
  an external store, and pollutes commerce and commission history.
- **Implement preview arithmetic directly in the React component** — Rejected
  because duplicated precedence, subscription, fixed-rate, and rounding logic
  could disagree with settlement.
- **Add a server preview API** — Rejected for the first version because the
  calculation is deterministic, needs no protected data after catalog loading,
  and does not justify a new public or internal API contract.

## Consequences

### Positive

- Merchants can verify mixed-cart, customer, and subscription scenarios before
  saving or activating a reward.
- Per-line output makes it explicit that overrides do not change unrelated cart
  lines.
- Production resolver reuse minimizes calculation drift.
- No test data, commission records, database migration, or API endpoint is
  required.

### Negative / trade-offs accepted

- The merchant supplies a commissionable example price; the simulator does not
  reproduce Shopify discounts, tax, FX, or refund processing.
- The simulator covers this Shopify reward configuration only and does not
  evaluate separate manual commission rules.
- Catalog prices are defaults for convenience and remain editable because the
  program accounting currency may differ from the Shopify catalog currency.

### Follow-ups

- Keep simulator tests alongside Shopify reward settlement tests so new rule
  modes cannot silently diverge.
- Consider adding discount and FX inputs only if merchants need reconciliation
  against an observed Shopify order.

## References

- Hiro approval to implement all four Shopify Reward follow-ups on 2026-08-23.
- `docs/adr/0009-dedicated-shopify-reward-conditions.md`
- `docs/adr/0010-shopify-reward-json-lifecycle.md`
- `/Users/hironguyen/.codex/memories/project_adr_0011.md`
