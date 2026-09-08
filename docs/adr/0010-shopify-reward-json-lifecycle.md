# ADR 0010: Shopify reward lifecycle in JSON config

- Date: 2026-08-23
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Shopify eCommerce Rewards need merchant-visible Draft, Scheduled, Active, and
Ended states so a commission policy can be prepared before launch and bounded
to a campaign window. Dub's shared `Reward` model does not currently define a
generic lifecycle for every reward type, while Shopify settlement already owns
configuration history and resolves the configuration effective at the order's
timestamp.

Adding shared Prisma columns or enums would make a Shopify-only capability part
of Dub's database contract, require a migration, and increase the overlap with
future upstream Reward changes. Keeping the lifecycle in application memory or
requiring a cron activation job would also make delayed webhooks and historical
order settlement dependent on mutable current state.

## Decision

Store Shopify lifecycle data inside the existing `Reward.config` JSON contract
under the dedicated `shopify_ecommerce` configuration. The lifecycle records
whether the reward is published plus optional ISO `startsAt` and `endsAt`
timestamps. Existing configurations default to published with no time bounds,
which preserves their current active behavior without a migration.

The UI derives Draft, Scheduled, Active, and Ended from this lifecycle. Shopify
settlement evaluates eligibility against the order occurrence timestamp, not
the webhook processing time. Configuration history entries include lifecycle
data, so delayed attribution continues to use the policy that was effective
when the order occurred. No scheduler or database-status transition is
required.

## Alternatives considered

- **Add status and timestamp columns to Dub's `Reward` model** — Rejected
  because it would impose a Shopify-specific lifecycle on the shared schema,
  require a migration, and enlarge the upstream merge surface.
- **Activate and end rewards with scheduled background jobs** — Rejected
  because job timing and retries could diverge from order-time eligibility and
  make historical settlement harder to reproduce.
- **Leave rewards permanently active** — Rejected because merchants need to
  prepare and bound commission campaigns without manually editing the reward at
  the exact launch or end time.

## Consequences

### Positive

- No Prisma migration or public API change is required.
- Shopify lifecycle logic remains isolated from generic Dub rewards.
- Old configurations remain active through schema defaults.
- Scheduled and ended rewards resolve deterministically for delayed orders.
- Upstream Dub upgrades have a smaller conflict surface.

### Negative / trade-offs accepted

- Prisma cannot filter Shopify reward lifecycle states as native columns; the
  application derives them after parsing `Reward.config`.
- The shared Dub Reward model does not automatically understand this
  lifecycle; partner-facing surfaces that expose Shopify rewards must use the
  Shopify availability helper.
- Any future generic lifecycle introduced by Dub will require an explicit
  reconciliation decision rather than transparently sharing these JSON fields.

### Follow-ups

- Add lifecycle controls and derived status to the dedicated Shopify reward UI.
- Enforce lifecycle eligibility in order-time configuration resolution.
- Cover legacy parsing, time boundaries, serialization, and historical config
  selection with focused tests.

## References

- Hiro approval in the Shopify eCommerce Reward design discussion on
  2026-08-23.
- `docs/adr/0009-dedicated-shopify-reward-conditions.md`
- `/Users/hironguyen/.codex/memories/project_adr_0010.md`
