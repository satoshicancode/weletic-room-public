# ADR 0003: Customer loyalty bounded context

- Date: 2026-08-16
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Weletic Room currently rewards creator Partners for attributed traffic and sales
through programs, groups, rewards, commissions, and payouts. Hiro wants merchants
to install one Shopify app for both the existing affiliate product and a new
customer loyalty product covering points, customer referrals, VIP tiers, expiry,
and rewards.

The existing Dub-derived `Customer` record is an attributed lead or conversion,
not a durable loyalty identity. It is coupled to links, Partners, and Programs,
and can be cascade-deleted through those relationships. Likewise,
`ProgramEnrollment`, `PartnerGroup`, `Commission`, `Payout`, workflows, and
`BountySubmission` encode Partner-specific identity, metrics, money, and payout
semantics. Reusing those records directly for shoppers would make points behave
like currency-denominated commissions and would couple customer data to creator
lifecycle operations.

The current Shopify order path is also attribution-first: orders without a known
Dub click, Partner discount, or existing attributed Customer can be skipped. A
loyalty program instead needs every eligible Shopify order and refund, regardless
of whether a Partner participated. The existing OpenClub loyalty implementation
contains useful prior art for ledgers, pending points, expiry, referral state,
tiers, and reward fulfillment, but it uses a different persistence stack,
contains broad affiliate and payout overlap, and has documented parity and live
acceptance gaps.

## Decision

Weletic Room will expose Affiliate and Customer Loyalty as independently enabled
modules inside one Shopify app installation. Internally, Customer Loyalty will be
a separate Weletic-owned bounded context rather than a Partner subtype. It will
introduce a store-scoped Shopper/Customer Profile plus loyalty-specific program,
account, append-only points ledger, rule, customer-referral, tier, tier-history,
reward, fulfillment, and segment records. A person may independently be both a
Partner and a Shopper; a future identity link may associate them without merging
their financial or lifecycle records.

Shopify commerce ingestion will become an unconditional factual layer. It will
upsert the store-scoped shopper, order, lines, and refunds first, then dispatch
optional processing to the Partner attribution/commission module and the
Customer loyalty module. Shared capabilities will include Shopify connectivity,
commerce facts, link and click attribution, rule conditions, discount
provisioning, idempotency, refund handling, fraud signals, notifications, and
analytics. Reward settlement remains actor-specific: Partner outcomes create
money-denominated commissions and payouts; Customer outcomes create points
ledger entries and reward fulfillments. Customer referral rewards will credit
points directly rather than create cash commissions and convert them.

OpenClub will be used as behavioral prior art and a source of edge cases and test
scenarios, not ported wholesale. Shopify customer metafields will be a disposable
read projection for balance and tier, while the Weletic points ledger remains the
source of truth. Shopify Store Credit may later be offered as one redemption
adapter, but it will not be the core points ledger.

## Alternatives considered

- **Port the complete OpenClub loyalty implementation** — Recreate its full
  model and service surface in Weletic. Rejected because the persistence stacks
  differ, affiliate and payout responsibilities overlap, several critical states
  are overly generic or JSON-backed, and the implementation still has documented
  Shopify parity gaps.
- **Treat Customers as Partners** — Reuse `Partner`, `ProgramEnrollment`,
  `PartnerGroup`, `Commission`, and `BountySubmission` directly. Rejected because
  customer identity, points, tier, privacy, and referral lifecycles are not
  Partner enrollment, cash commission, KYC, or payout lifecycles.
- **Build a universal Participant/Incentive platform immediately** — Migrate
  Partners and Customers to a polymorphic actor and reward model. Rejected for
  now because it would create the largest migration and regression surface in the
  already working affiliate system before customer use cases validate the
  abstraction.
- **Use Shopify Store Credit as the loyalty balance** — Let Shopify hold the
  authoritative reward balance. Rejected because store credit is monetary and
  currency-specific, whereas points also drive activities, tiers, referrals, and
  non-cash rewards. Store credit remains eligible as a future fulfillment target.

## Consequences

### Positive

- Merchants get one Shopify installation and one Weletic merchant experience.
- Partner commissions and Customer points retain correct identity, accounting,
  privacy, and lifecycle semantics.
- All eligible Shopify commerce can support loyalty without manufacturing an
  affiliate attribution.
- Existing Weletic rule UI, attribution, commerce, discount, refund, fraud, and
  automation patterns remain reusable through explicit adapters.
- The points ledger can preserve rule snapshots and reverse exactly what the
  original order earned, even after merchants edit earning rules.
- Dub upstream compatibility is safer because Weletic-specific customer loyalty
  data stays outside Partner-owned records.

### Negative / trade-offs accepted

- The first loyalty release requires new schemas, services, event adapters, and
  customer-facing surfaces rather than merely relabeling existing Partner UI.
- Some concepts will initially have parallel Partner and Customer records even
  when their merchant editors look similar.
- One Shopify app couples release and incident blast radius across modules, so
  feature flags, module kill switches, independent queues, and optional scopes
  are required.
- Protected customer data increases privacy review, retention, deletion, access,
  and audit obligations.
- A universal incentive abstraction is deferred; later extraction may require
  another ADR after both domains have demonstrated stable common behavior.

### Follow-ups

- Harden the Shopify app before protected-customer-data expansion: persistent
  sessions, supported API version, synchronized webhook declarations, optional
  scopes, secret handling, uninstall cleanup, and complete redaction behavior.
- Refactor commerce persistence so store-owned shoppers, orders, and refunds are
  recorded for all eligible events; make affiliate Program and Partner
  attribution optional facts rather than ingestion prerequisites.
- Define the Customer Loyalty schema under the Weletic-owned Prisma boundary and
  implement an append-only, idempotent points ledger with pending, available,
  redeem, adjust, expire, and reversal entries plus cached balances.
- Ship points-first: purchase earning, holding period, exact refund reversal,
  manual adjustment, balance projection, and discount redemption.
- Add customer referrals with advocate/friend identity, qualifying-order rules,
  two-sided rewards, fraud controls, holding, and refund reversal.
- Add VIP tiers, qualification windows, upgrade/downgrade policy, tier history,
  entry rewards, and ongoing perks; keep multi-membership customer segments
  separate from ordinal tiers.
- Generalize selected Bounty and Workflow concepts into Customer Challenges only
  after concrete customer activity cases are validated.

## References

- Hiro approval of Option A in the Weletic Room architecture discussion on
  2026-08-16.
- `/Users/hironguyen/.codex/memories/project_adr_0003.md`
- `apps/web/prisma/schema/customer.prisma`
- `apps/web/prisma/schema/group.prisma`
- `apps/web/prisma/schema/commission.prisma`
- `apps/web/prisma/schema/bounty.prisma`
- `apps/web/prisma/schema/weletic-commerce.prisma`
- `apps/web/app/(ee)/api/shopify/integration/webhook/orders-paid.ts`
- `/Users/hironguyen/Code/openclub/docs/adr/0023-shopify-soho-vendor-unified-app.md`
- `/Users/hironguyen/Code/openclub/docs/shopify/smile-loyalty-parity-audit.md`
- https://shopify.dev/docs/apps/build/authentication-authorization/app-installation/manage-access-scopes
- https://shopify.dev/docs/apps/launch/protected-customer-data
