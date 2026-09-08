# Superseded Smile.io parity analysis

**Original date:** 2026-08-18

**Superseded:** 2026-08-30

**Status:** Do not use for production-readiness or parity claims

The earlier migration report claimed 100% Smile.io Growth parity. Repository review and evidence-qualified live-store validation found that claim was not supported. This file is historical; [capability-matrix.md](./capability-matrix.md) is the status authority.

The implementation-state corrections below preserve historical snapshots recorded during the 2026-08-30 through 2026-08-31 closure audit. They are intentionally not rewritten as features evolve. Later Gift Card, Store Credit, POS, social-action, Judge.me, Loyalty Hub, real-checkout, and lifecycle evidence must be read from the current capability matrix and linked reports.

Material corrections include:

- The loyalty ledger is an append-only signed-delta event ledger, not double-entry bookkeeping.
- Several unit tests use in-memory Prisma simulations. A separate opt-in MySQL suite now covers real concurrent ledger writes; simulation tests must not be described as real database evidence.
- At this snapshot, signup and birthday had only partial evidence, while social, link-click, and review actions remained domain primitives without verified provider adapters. Later implementation and evidence are recorded only in the current capability matrix.
- At this snapshot, Gift Card, Store Credit, POS rewards, Shopify Flow triggers, ESP integrations, and a Smile-style on-site editor were not implemented.
- At this snapshot, Customer Account and Online Store theme/App Proxy evidence had to be tracked separately. The target Customer Account extension was deployed/enabled and passed one logged-in fixed-amount redemption with coupon wallet/history persistence. The theme/App Proxy shopper flow built but was not equivalently live-validated. Shopify Plus Checkout UI activation and the external partner-store service remain deferred in current scope.
- Shopify discount provisioning uses GraphQL Admin API `2026-07`, not the previously documented `2025-01` or legacy REST PriceRule flow.
- Customer identity must enter through verified Shopify App Proxy or session-token gateways. The old direct customer routes are retired with HTTP 410.
- PR #24 completed one targeted staging outbox batch with no active failures/dead letters. V14 adds exact store/job-scoped logical-time evidence for selected lifecycle workers, but continuous scheduling, supervision, alerting, and untested job paths remain environment-specific gates.
- The target staging database completed the staged canonical discount-code constraint and retained-install activation. Every other environment must repeat the stage-1 audit/backfill, global stage-2 cardinality gate, installation-generation activation, verified-currency check, and compliance gates.
- The [hardened infrastructure-validator report](./evidence/infrastructure-validator-staging-2026-08-31-v2.json) passed 16/16 checks, including native fixed-amount, percentage, free-shipping, and free-product/BXGY adapter creation, exact readback, deactivation/deletion, exact-GID absence cleanup, and webhook provisioning.
- The separate final [A1 Shopify Basic lifecycle v14 report](./evidence/a1-basic-lifecycle-staging-2026-08-31-v14.json) passed 13/13 checks and cleanup. It combines live customer provisioning and Shopify Admin readback with HMAC-signed synthetic order/refund/referral/privacy ingress and logical-time workers. It does not prove a real checkout/order/refund, coupon acceptance, external data-request delivery, uninstall/shop erasure, Shopify Plus, external partner, or Online Store theme/App Proxy flow.
- `docs/architecture/LOYALTY_DEEPENING_SPECIFICATION.md` is a superseded, non-authoritative design proposal and must not be cited for current status, parity, or readiness.
- The custom Shopify Plus Checkout UI extension and an external partner-store service remain deferred from the current in-house Shopify Basic scope. Native reward acceptance in standard Shopify Basic checkout remains included.

The current evidence, target-store observations, reusable Weletic components, and exact gaps are maintained in [capability-matrix.md](./capability-matrix.md).
