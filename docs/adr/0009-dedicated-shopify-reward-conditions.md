# ADR 0009: Dedicated Shopify reward conditions

- Date: 2026-08-23
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Shopify commission behavior can currently be expressed through two separate
paths: Shopify-specific conditions attached to the generic Sale Reward and the
dedicated Shopify eCommerce Reward configuration. The generic path exposes
Shopify products, collections, variants, and product tags as boolean reward
conditions, then converts matching modifiers into settlement rules. The
dedicated path already owns customer-history classification, catalog override
precedence, subscription commission modes, configuration history, and Shopify
order settlement.

Keeping both paths makes it unclear which editor is authoritative and requires
the settlement engine to reconcile two representations of the same business
policy. It also leaves Shopify controls in the generic condition builder even
though product and collection overrides are not generic AND/OR predicates.

A local data audit found no rewards with legacy Shopify modifiers, no generated
legacy Shopify commission rules, and no commerce orders. The local database
also does not contain the planned Shopify reward snapshot column, confirming
that this settlement design has not yet been deployed from this branch. A data
migration or compatibility backfill is therefore unnecessary.

## Decision

`Reward.config.type = "shopify_ecommerce"` is the only Sale Reward-linked
configuration source for Shopify order commissions. A generic Sale Reward does
not pay a Shopify order; its partner group or enrollment must instead resolve to
a dedicated Shopify eCommerce Reward. Explicit Weletic commission rules remain
independent inputs to the existing settlement precedence. The generic Sale
Reward remains available for non-Shopify sales but no longer offers, parses,
evaluates, snapshots, or materializes Shopify-specific conditions for Shopify
settlement.

The dedicated configuration supports independent overrides for Shopify
variants, products, and collections. Settlement applies the first matching
scope in this order:

1. Variant
2. Product
3. Collection
4. All products (the dedicated base rate)

Variant overrides use the same customer mode and rate type as the base rule.
The first listed matching collection continues to win when a product belongs to
multiple configured collections. Product-tag predicates and generic AND/OR
composition remain outside the dedicated editor.

Existing dedicated configurations remain valid by defaulting the new
`variantOverrides` field to an empty array. No database schema or public API
migration is required.

## Alternatives considered

- **Keep the generic Sale Reward base-rate fallback for Shopify orders** —
  Rejected because it preserves two possible Shopify commission sources and
  makes the absence of a dedicated configuration ambiguous.
- **Hide the legacy Shopify condition UI but keep settlement compatibility** —
  Rejected because the audit found no data requiring compatibility and the
  unused branches would continue to complicate settlement.
- **Migrate legacy Shopify modifiers into dedicated configurations** — Rejected
  because there are no local legacy configurations or generated rules to
  migrate.
- **Move product tags and generic AND/OR conditions into the dedicated editor**
  — Rejected because Shopify overrides follow deterministic specificity, not
  boolean condition composition.
- **Delete the generic Sale Reward evaluator** — Rejected because it remains
  necessary for non-Shopify sale, customer, and partner conditions.

## Consequences

### Positive

- Shopify commissions have one merchant-facing editor and one settlement path.
- Variant-specific rates are supported without reintroducing generic boolean
  criteria.
- Settlement precedence is explicit and testable.
- Obsolete Shopify-specific parsing, evaluation, snapshot, and materialization
  branches can be removed.
- Older dedicated configurations load without a migration.

### Negative / trade-offs accepted

- A group with only a generic Sale Reward receives no Shopify order commission.
- Existing external callers attempting to submit Shopify entities in Sale
  Reward modifiers will fail validation.
- Product-tag commission targeting is unavailable until it is justified as a
  dedicated Shopify feature.

## References

- Hiro approval of Option A, Shopify eCommerce Reward only, on 2026-08-23.
- `docs/adr/0008-shopify-app-production-security-boundary.md`
- `/Users/hironguyen/.codex/memories/project_adr_0009.md`
