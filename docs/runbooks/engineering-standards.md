# Weletic Room Engineering & Verification Standards

## 1. Core Rule: Self-Testing & E2E Verification Before Reporting

Every feature, bug fix, or data integration MUST strictly follow this 4-phase cycle:

1. **Plan & Root Cause Analysis:**
   - Investigate existing database schema, APIs, and business invariants before touching code.
2. **Implementation:**
   - Apply minimal, clean, robust code changes respecting Dub upstream isolation and Weletic prefixes.
3. **Automated E2E Verification:**
   - Execute unit and integration tests covering the exact user scenario.
   - Test all edge cases (e.g. empty filter states, multiple market prices, currency conversions, session fallbacks).
   - Verify build integrity with `pnpm build` across affected packages (`apps/web`, `packages/shopify-app`).
4. **Transparent Reporting:**
   - Report only after all tests pass with 100% green status.
   - Highlight exact technical fixes, root causes, and verification steps.

---

## 2. Multi-Market Pricing Matrix Standards

- Store must respect the 4 official Shopify Markets:
  - **Vietnam (Primary):** Currency `VND`.
  - **Japan:** Currency `JPY`.
  - **Mexico:** Currency `MXN`.
  - **International (27 regions):** Currencies `USD`, `EUR`, `GBP`, `CAD`, `AUD`.
- Product queries must never return empty screens due to market fallback; variant `shopPrice` acts as the guaranteed baseline.
