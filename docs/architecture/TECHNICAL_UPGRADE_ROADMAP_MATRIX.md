# Weletic Commerce Platform: Technical Upgrade Roadmap Matrix

**Document Version:** 1.0.0  
**Status:** Canonical Strategic Roadmap  
**Author:** Master Platform Architect & Roadmap Strategist (Worker 4)  
**Target Horizon:** Q3 2026 – Q2 2027 (4-Quarter Engineering Plan)  
**Related Specifications:**

- `docs/architecture/WELETIC_COMMERCE_MASTER_ARCHITECTURE.md`
- `docs/architecture/LOYALTY_DEEPENING_SPECIFICATION.md`
- `docs/architecture/SCALABILITY_CACHING_INFRASTRUCTURE_SPEC.md`
- `docs/architecture/FLYWHEEL_ANALYTICS_FRAUD_SHIELD_SPEC.md`

---

## 1. Strategic Prioritization & Scoring Framework

The Weletic Commerce Platform roadmap is governed by a quantitative evaluation model designed to balance **immediate merchant conversion gains**, **infrastructure stability under flash sales**, and **long-term network flywheel defensibility**.

### 1.1 Scoring Methodology

$$\text{Priority Score} = \frac{\text{Business Impact} \times \text{Strategic Alignment}}{\text{Technical Complexity} \times \text{Risk Factor}} \times 10$$

| Dimension                | Scale | Evaluation Criteria                                                                                                        |
| ------------------------ | :---: | -------------------------------------------------------------------------------------------------------------------------- |
| **Business Impact**      | 1 – 5 | 1: Minor polish; 3: Moderate retention lift; 5: Massive conversion / GMV / margin expansion.                               |
| **Strategic Alignment**  | 1 – 5 | 1: Point feature; 3: Platform parity; 5: Core Flywheel multiplier & competitive moat.                                      |
| **Technical Complexity** | 1 – 5 | 1: Pure configuration / simple route; 3: Multi-service coordination; 5: Distributed consensus / external API dependencies. |
| **Person-Weeks (PW)**    | Weeks | Fully loaded engineering effort across Backend, Frontend, Infra, and QA.                                                   |
| **Risk Factor**          | 1 – 3 | 1: Low (Isolated component); 2: Medium (Data mutation); 3: High (Checkout / Financial settlement path).                    |

---

## 2. Master Impact vs. Effort Prioritization Matrix

```
       ▲ HIGH
       │
       │  ┌──────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
       │  │             QUICK WINS                   │   │          STRATEGIC UPGRADES              │
       │  │  (High Impact, Low/Medium Effort)        │   │   (High Impact, High Complexity)         │
       │  │                                          │   │                                          │
       │  │ • F06: 2-Tier Read Caching (LRU + Redis) │   │ • F02: Shopify Plus Checkout UI Slider   │
       │  │ • F08: Multi-Market FX Sync & JPY Fix    │   │ • F07: BullMQ Distributed Webhook Queue  │
I      │  │ • F01.1: Birthday Sweeper Daemon         │   │ • F10: Advocate-to-Affiliate Funnel      │
M      │  │ • F12.1: Canonical Email Normalization   │   │ • F12.2: Cross-Network Risk Score Engine │
P      │  │ • F03.1: VIP 30-Day Grace Warnings       │   │ • F03.2: Automated Tier Lifecycle Review │
A      │  │                                          │   │ • F04: Dynamic Segment Multipliers       │
C      │  └──────────────────────────────────────────┘   └──────────────────────────────────────────┘
T      │
       │  ┌──────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
       │  │          TACTICAL ENHANCEMENTS           │   │          LONG-TERM INNOVATIONS           │
       │  │   (Moderate Impact, Low Effort)          │   │  (High Strategic Value, High Complexity) │
       │  │                                          │   │                                          │
       │  │ • F01.3: Social Action Callbacks         │   │ • F05: Shopify Store Credit API Adapter  │
       │  │ • F01.2: Product Review Webhook Adapters │   │ • F11: Multi-Channel LTV/CAC Modeling    │
       │  │ • F12.3: Shipping Address Fuzzy Match    │   │ • F09: Vanity Subdomain Edge Routing     │
       │  │                                          │   │                                          │
       │  └──────────────────────────────────────────┘   └──────────────────────────────────────────┘
       │
       └─────────────────────────────────────────────────────────────────────────────────────────────►
         LOW                             EFFORT / COMPLEXITY                                     HIGH
```

---

## 3. Executive Initiative Summary Table

| Initiative ID | Initiative Name                               | Category             | Business Impact (1-5) | Tech Complexity (1-5) | Est. Effort (PW) | Target Quarter | Priority Score |
| ------------- | --------------------------------------------- | -------------------- | :-------------------: | :-------------------: | :--------------: | :------------: | :------------: |
| **F06**       | 2-Tier Storefront Widget Read Caching         | Quick Win            |           5           |           2           |      2.0 PW      |  **Q3 2026**   |    **25.0**    |
| **F08**       | Multi-Market FX Base Normalization & JPY Fix  | Quick Win            |           5           |           1           |      1.5 PW      |  **Q3 2026**   |    **33.3**    |
| **F12.1**     | Canonical Email Hashing & Sybil Shield        | Quick Win            |           4           |           1           |      1.0 PW      |  **Q3 2026**   |    **26.7**    |
| **F01.1**     | Customer Birthday Sweeper & 30d Lock          | Quick Win            |           4           |           2           |      1.5 PW      |  **Q3 2026**   |    **20.0**    |
| **F07**       | BullMQ Distributed Queue & 100k+ Backfill     | Strategic Upgrade    |           5           |           4           |      4.0 PW      |  **Q3 2026**   |    **15.6**    |
| **F02**       | Shopify Plus Checkout UI Slider Extension     | Strategic Upgrade    |           5           |           4           |      4.5 PW      |  **Q4 2026**   |    **15.6**    |
| **F10**       | Advocate-to-Affiliate Conversion Funnel       | Strategic Upgrade    |           5           |           3           |      3.5 PW      |  **Q4 2026**   |    **19.4**    |
| **F12.2**     | Cross-Network Risk Score & Velocity Engine    | Strategic Upgrade    |           4           |           3           |      3.0 PW      |  **Q4 2026**   |    **14.8**    |
| **F03**       | VIP Tier Lifecycle, Grace Period & Step-Down  | Strategic Upgrade    |           4           |           3           |      2.5 PW      |  **Q4 2026**   |    **14.8**    |
| **F04**       | Dynamic Campaign Multipliers & Rule Engine    | Strategic Upgrade    |           4           |           3           |      2.5 PW      |  **Q1 2027**   |    **13.3**    |
| **F05**       | Shopify Store Credit GraphQL API Adapter      | Long-Term Innovation |           5           |           4           |      4.0 PW      |  **Q1 2027**   |    **14.3**    |
| **F11**       | Unified Multi-Channel LTV/CAC Cohort Modeling | Long-Term Innovation |           5           |           4           |      4.5 PW      |  **Q1 2027**   |    **14.3**    |
| **F09**       | Branded Vanity Subdomain Edge Routing         | Long-Term Innovation |           4           |           3           |      3.0 PW      |  **Q2 2027**   |    **13.3**    |

---

## 4. Detailed Per-Initiative Architectural Cards

### 4.1 Quick Wins (Q3 2026 Foundation)

```
====================================================================================================
CARD F06: 2-Tier Storefront Widget Read Caching (In-Memory LRU + Upstash Redis Global)
====================================================================================================
• Business Value: Eliminates database connection saturation during flash sales (99.6% read offload),
  reducing storefront widget p95 read latency from 380ms to <18ms. Directly prevents storefront lag.
• Technical Complexity: Low/Medium (LRU cache configuration, Redis key management, event invalidators).
• Effort Estimate: 2.0 Person-Weeks (BE: 1.2 PW, Infra: 0.5 PW, QA: 0.3 PW).
• Target Quarter: Q3 2026 (Sprint 1).
• Prerequisites: None (Upstash Redis Global already provisioned).
• Architecture Blueprint: apps/web/lib/weletic/loyalty/cache.ts with SingleFlight request coalescing.
• Failure Modes: Redis timeout/outage.
• Rollback Strategy: Fail-open fallback to primary database queries via redisGlobalWithTimeout.
• Verification Metric: k6 load test at 1,000 RPS achieving p95 < 20ms and <25 database QPS.
====================================================================================================
```

```
====================================================================================================
CARD F08: Multi-Market FX Base Normalization & JPY/VND Points Inflation Fix
====================================================================================================
• Business Value: Fixes critical financial exploit where zero-decimal currencies (JPY, VND) receive
  100x excess points, causing 200% return on spend and catastrophic merchant loss on international sales.
• Technical Complexity: Low (Mathematical refactoring of earn.ts and tiers.ts with 12-decimal rational math).
• Effort Estimate: 1.5 Person-Weeks (BE: 1.0 PW, QA: 0.5 PW).
• Target Quarter: Q3 2026 (Sprint 1).
• Prerequisites: CurrencyAPI key for daily USD base exchange rate ingestion.
• Architecture Blueprint: apps/web/lib/weletic/fx.ts and calculateCalibratedOrderPoints in earn.ts.
• Failure Modes: FX API unavailable or returning stale rates.
• Rollback Strategy: Fallback to cached Redis FX table (TTL 48h) or static hardcoded rate safety floor.
• Verification Metric: Unit tests asserting ¥10,000 JPY spend yields exact parity (~65 points) with $65 USD.
====================================================================================================
```

```
====================================================================================================
CARD F12.1: Canonical Email Normalization & SHA-256 Hashing Shield
====================================================================================================
• Business Value: Blocks Sybil attacks and Gmail alias farms (+tag and dot recycling) from harvesting
  unearned welcome points and duplicate 1-click discount vouchers.
• Technical Complexity: Low (Deterministic string parsing and SHA-256 hashing across providers).
• Effort Estimate: 1.0 Person-Weeks (BE: 0.7 PW, QA: 0.3 PW).
• Target Quarter: Q3 2026 (Sprint 2).
• Prerequisites: None.
• Architecture Blueprint: canonicalizeEmail & computeCanonicalEmailHash in apps/web/lib/weletic/fraud/.
• Failure Modes: False positive collision on non-standard email domain format.
• Rollback Strategy: Fallback to raw lowercase email matching if canonical parser throws.
• Verification Metric: Test matrix confirming john.doe+promo@gmail.com matches johndoe@gmail.com.
====================================================================================================
```

```
====================================================================================================
CARD F01.1: Customer Birthday Sweeper Daemon & 30-Day Anti-Gaming Lock
====================================================================================================
• Business Value: Drives annual delight and re-engagement via birthday points, while 30-day lockout
  prevents instant signup-day exploitation.
• Technical Complexity: Low/Medium (Cron sweeper daemon, store timezone normalization, idempotency keys).
• Effort Estimate: 1.5 Person-Weeks (BE: 1.0 PW, QA: 0.5 PW).
• Target Quarter: Q3 2026 (Sprint 2).
• Prerequisites: WeleticShopper birthday fields migration.
• Architecture Blueprint: sweepBirthdayRewards daemon in apps/web/app/(ee)/api/cron/loyalty/birthdays/.
• Failure Modes: Timezone skew across global stores causing early/late reward delivery.
• Rollback Strategy: Cron idempotent re-run capability; dry-run preview flag before points issuance.
• Verification Metric: Hermetic test verifying birthday set within 30 days is deferred to next year.
====================================================================================================
```

---

### 4.2 Strategic Upgrades (Q3–Q4 2026)

```
====================================================================================================
CARD F07: BullMQ Distributed Webhook Queue & 100k+ Resumable Backfill Pipeline
====================================================================================================
• Business Value: Guarantees <150ms webhook acknowledgment, eliminating Shopify 5-second timeout
  failures and app uninstalls. Enables seamless 100k+ historical order onboarding without OOM crashes.
• Technical Complexity: High (Distributed queue workers, Redis cursor checkpoints, token bucket rate limiter).
• Effort Estimate: 4.0 Person-Weeks (BE: 2.2 PW, Infra: 1.0 PW, QA: 0.8 PW).
• Target Quarter: Q3 2026 (Sprint 3–4).
• Prerequisites: Upstash QStash / BullMQ cluster setup (ADR-002).
• Architecture Blueprint: Fast-path webhook router + chunked cursor backfill in apps/web/lib/weletic/loyalty/.
• Failure Modes: Worker process crash or Shopify 429 throttling.
• Rollback Strategy: Redis cursor checkpoint resume on crash; Dead Letter Queue (DLQ) for failed tasks.
• Verification Metric: 100k simulated order backfill running within <64MB heap memory with zero errors.
====================================================================================================
```

```
====================================================================================================
CARD F02: Shopify Plus Checkout UI Slider Extension & 15-Minute Reservation Lock
====================================================================================================
• Business Value: Drives 8–15% checkout conversion lift on Shopify Plus by allowing variable points
  redemption directly on the checkout screen without leaving the funnel.
• Technical Complexity: High (Shopify Checkout UI Extension, WebAssembly runtime, atomic Redis Lua lock).
• Effort Estimate: 4.5 Person-Weeks (FE: 2.0 PW, BE: 1.5 PW, QA: 1.0 PW).
• Target Quarter: Q4 2026 (Sprint 5–6).
• Prerequisites: Shopify Plus Partner development store; ADR-001 approval.
• Architecture Blueprint: extensions/loyalty-checkout-slider + POST /api/shopify/loyalty/checkout/reserve.
• Failure Modes: Double-redemption race conditions; checkout abandonment lock leaks.
• Rollback Strategy: Automatic 15-minute TTL expiration in Redis; fallback to 1-click cart drawer voucher.
• Verification Metric: Concurrency test with 10 simultaneous reservations on 1,000 points allowing only 1.
====================================================================================================
```

```
====================================================================================================
CARD F10: Advocate-to-Affiliate Conversion Funnel & 1-Click Graduation Saga
====================================================================================================
• Business Value: Automates the Growth Flywheel by converting high-performing customer advocates
  (>=5 referrals, >=$500 GMV) into official creator partners, expanding organic viral distribution.
• Technical Complexity: Medium/High (Dynamic 0-100 scoring algorithm, HMAC invitation tokens, atomic saga).
• Effort Estimate: 3.5 Person-Weeks (BE: 2.0 PW, FE: 1.0 PW, QA: 0.5 PW).
• Target Quarter: Q4 2026 (Sprint 7–8).
• Prerequisites: ADR-0003 compliance; WeleticAdvocateCandidate schema migration.
• Architecture Blueprint: apps/web/lib/weletic/flywheel/graduate-advocate.ts.
• Failure Modes: Partial provisioning failure on Shopify discount creation.
• Rollback Strategy: Transactional saga rollback in PostgreSQL leaving candidate in 'invited' state.
• Verification Metric: 1-click graduation creating Partner, Dub shortlink, discount code, and Room.
====================================================================================================
```

```
====================================================================================================
CARD F12.2: Cross-Network Risk Score & Sliding-Window IP Velocity Shield
====================================================================================================
• Business Value: Eliminates affiliate self-purchases, cross-network commission double-dipping, and bot
  referral scraping, protecting merchant marketing margins.
• Technical Complexity: Medium/High (Sliding-window Redis Lua script, composite 0-100 risk scoring).
• Effort Estimate: 3.0 Person-Weeks (BE: 2.0 PW, FE: 0.5 PW, QA: 0.5 PW).
• Target Quarter: Q4 2026 (Sprint 8).
• Prerequisites: ADR-003 approval; WeleticFraudRiskAssessment schema.
• Architecture Blueprint: evaluateCrossNetworkRisk in apps/web/lib/weletic/fraud/risk-engine.ts.
• Failure Modes: False positive blocking of legitimate high-volume shoppers.
• Rollback Strategy: Dual-tier quarantine (FLAG_REVIEW) holding points/commissions without blocking checkout.
• Verification Metric: Redis Lua script rejecting 4th referral bind from same IP within 24 hours.
====================================================================================================
```

```
====================================================================================================
CARD F03: VIP Tier Lifecycle, 30-Day Grace Period & Soft Downgrade Step-Down
====================================================================================================
• Business Value: Eliminates permanent tier liability while preventing customer churn through gentle
  single-tier step-downs and proactive 30-day warning webhooks to Klaviyo/Shopify Flow.
• Technical Complexity: Medium (Rolling 12-month spend maintenance, annual review daemon, state transitions).
• Effort Estimate: 2.5 Person-Weeks (BE: 1.8 PW, QA: 0.7 PW).
• Target Quarter: Q4 2026 (Sprint 7).
• Prerequisites: WeleticLoyaltyTier maintenance fields.
• Architecture Blueprint: /api/cron/loyalty/tier-lifecycle and evaluateAccountTier in tiers.ts.
• Failure Modes: Accidental hard-demotion of active VIPs due to currency mismatch.
• Rollback Strategy: Tier snapshot history in WeleticLoyaltyTierHistory allows 1-click administrative revert.
• Verification Metric: Test confirming Gold VIP with spend < threshold steps down to Silver, not Bronze.
====================================================================================================
```

---

### 4.3 Long-Term Innovations (Q1–Q2 2027)

```
====================================================================================================
CARD F05: Shopify Store Credit GraphQL API Adapter (2024-04+)
====================================================================================================
• Business Value: Enables true discount code stacking at checkout (shoppers can use a promo code AND
  loyalty store credit). Delivers omnichannel loyalty across Online Store, Shop Pay, and Shopify POS.
• Technical Complexity: High (Shopify Admin GraphQL 2024-04+ API, scope management, compensating saga).
• Effort Estimate: 4.0 Person-Weeks (BE: 2.5 PW, FE: 0.8 PW, QA: 0.7 PW).
• Target Quarter: Q1 2027 (Sprint 9–10).
• Prerequisites: Shopify write_store_credit_accounts OAuth scope grant.
• Architecture Blueprint: redeemStoreCreditAdapter in apps/web/lib/weletic/loyalty/store-credit.ts.
• Failure Modes: Store Credit mutation failure after points ledger debit.
• Rollback Strategy: Automatic compensating ledger credit (MANUAL_ADJUSTMENT) within transactional saga.
• Verification Metric: Test verifying points deduction, store credit issuance, and failure rollback.
====================================================================================================
```

```
====================================================================================================
CARD F11: Unified Multi-Channel LTV/CAC Cohort Modeling in Tinybird ClickHouse
====================================================================================================
• Business Value: Provides executive BI comparing 30/60/90/180/365-day cumulative LTV and blended CAC
  across Organic, Affiliate, and Loyalty-Referred cohorts. Proves Flywheel ROI to merchants.
• Technical Complexity: High (Tinybird streaming data pipelines, ClickHouse SQL materialized views).
• Effort Estimate: 4.5 Person-Weeks (Data/BE: 2.5 PW, FE/BI: 1.2 PW, QA: 0.8 PW).
• Target Quarter: Q1 2027 (Sprint 11–12).
• Prerequisites: Tinybird workspace setup; weletic_order_events event schema.
• Architecture Blueprint: packages/tinybird/datasources/shopper_cohort_ltv_mv.sql.
• Failure Modes: High query latency on multi-million row datasets.
• Rollback Strategy: Fallback to pre-aggregated daily summary tables in PostgreSQL.
• Verification Metric: Sub-200ms dashboard queries across 10M historical order rows.
====================================================================================================
```

```
====================================================================================================
CARD F09: Branded Vanity Subdomain Edge Routing & First-Party Cookie Injection
====================================================================================================
• Business Value: Protects referral attribution against privacy browser parameter stripping (ITP/Brave)
  while providing high-converting shortlinks (yamax.link/ref/ALICE) for customer advocates.
• Technical Complexity: Medium/High (Cloudflare Workers, Dub edge router, custom domain SSL provisioning).
• Effort Estimate: 3.0 Person-Weeks (Infra/Edge: 1.8 PW, BE: 0.7 PW, QA: 0.5 PW).
• Target Quarter: Q2 2027 (Sprint 13–14).
• Prerequisites: Cloudflare Workers Custom Domains / Dub enterprise routing infrastructure.
• Architecture Blueprint: apps/web/lib/middleware/referral-edge.ts.
• Failure Modes: Edge DNS misconfiguration or Redis edge lookup failure.
• Rollback Strategy: Fallback 302 redirect to canonical store domain without query params.
• Verification Metric: Edge redirect executing in <15ms with weletic_ref first-party cookie injected.
====================================================================================================
```

---

## 5. Execution Phasing & Resource Allocation Timeline

```
====================================================================================================
ENGINEERING RESOURCE ALLOCATION GANTT (Q3 2026 - Q2 2027)
====================================================================================================

PHASE 1: QUICK WINS & HARDENING (Q3 2026 | Weeks 1-6)
├── F06: 2-Tier Caching (LRU + Redis)        [====] (Weeks 1-2 | 2.0 PW)
├── F08: FX Base Normalization & JPY Fix     [===]  (Weeks 1-2 | 1.5 PW)
├── F12.1: Canonical Email Hashing           [==]   (Weeks 3-4 | 1.0 PW)
├── F01.1: Birthday Sweeper Daemon           [===]  (Weeks 3-4 | 1.5 PW)
└── F07: BullMQ Distributed Queue Pipeline   [========] (Weeks 3-6 | 4.0 PW)

PHASE 2: CHECKOUT & RETENTION TRANSFORMATION (Q4 2026 | Weeks 7-14)
├── F02: Shopify Plus Checkout UI Slider     [=========] (Weeks 7-11 | 4.5 PW)
├── F03: VIP Tier Lifecycle & Soft Downgrade [=====]     (Weeks 9-11 | 2.5 PW)
├── F10: Advocate-to-Affiliate Funnel        [=======]   (Weeks 11-14 | 3.5 PW)
└── F12.2: Cross-Network Risk Score Engine   [======]    (Weeks 12-14 | 3.0 PW)

PHASE 3: ENTERPRISE REDEMPTION & ADVANCED ANALYTICS (Q1 2027 | Weeks 15-22)
├── F04: Dynamic Campaign Multipliers        [=====]     (Weeks 15-17 | 2.5 PW)
├── F05: Shopify Store Credit GraphQL API    [========]  (Weeks 17-20 | 4.0 PW)
└── F11: Tinybird Multi-Channel LTV Cohorts  [=========] (Weeks 18-22 | 4.5 PW)

PHASE 4: EDGE NETWORKING & OMNICHANNEL SCALE (Q2 2027 | Weeks 23-28)
├── F09: Vanity Subdomain Edge Routing       [======]    (Weeks 23-25 | 3.0 PW)
└── F01.2: Product Review Webhook Adapters   [====]      (Weeks 26-28 | 2.0 PW)
====================================================================================================
```

### Total Loaded Headcount & Effort Summary

- **Total Person-Weeks**: **37.5 Person-Weeks** across 4 Quarters.
- **Team Allocation**: 2 Senior Fullstack Engineers, 1 Platform/Infra Engineer, 0.5 QA Automation Engineer.
- **Quarterly Budget**:
  - Q3 2026: 10.0 PW (Fast wins + core scalability)
  - Q4 2026: 13.5 PW (Checkout transformation + Flywheel funnel)
  - Q1 2027: 11.0 PW (Store Credit + Tinybird LTV analytics)
  - Q2 2027: 5.0 PW (Edge vanity routing + review ecosystem)

---

## 6. Milestone Quality Gates & Governance

Each phase must clear strict, independent architectural gates before production deployment:

1. **Gate 1 (Scalability & Integrity Gate - End of Q3 2026)**:
   - Zero double-entry ledger sequence anomalies under concurrency.
   - 100% of webhooks acknowledged in <150ms during simulated 1,000 RPS burst.
   - 100k backfill completed with heap memory usage strictly $<64\text{MB}$.
2. **Gate 2 (Checkout & Security Gate - End of Q4 2026)**:
   - 100% protection against concurrent multi-tab slider redemption race conditions.
   - Zero unhandled exceptions during Shopify Plus checkout render.
   - False positive rate on risk scoring shield $<0.5\%$.
3. **Gate 3 (Financial & Analytical Gate - End of Q1 2027)**:
   - Store credit compensating saga achieves 100% recovery during simulated Shopify API 500 outages.
   - Tinybird cohort analytics queries execute in $<250\text{ms}$ on 10M rows.

---

_Technical Upgrade Roadmap Matrix authored and certified by Worker 4._
