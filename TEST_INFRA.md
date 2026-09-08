# E2E Test Infra: Weletic Room SWR Reactivity

## Test Philosophy

- Opaque-box and contract-driven verification of SWR cache mutation pipelines.
- Verify that mutations across modals trigger instant SWR revalidation of composite and sub-resource queries without full page reloads.
- Zero regressions against existing 864+ tests baseline.
- Methodology: Category-Partition + Boundary Value Analysis + Pairwise Combinations + Real-World Workflow Scenarios.

## Feature Inventory

| #   | Feature                                  | Source (requirement) | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
| --- | ---------------------------------------- | -------------------- | :----: | :----: | :----: | :----: |
| 1   | SWR Mutate Helper Abstractions           | ORIGINAL_REQUEST §R3 |   5    |   5    |   ✓    |   ✓    |
| 2   | Partner Detail Composite Cache Fix       | ORIGINAL_REQUEST §R1 |   5    |   5    |   ✓    |   ✓    |
| 3   | Discount Code Modal Reactivity           | ORIGINAL_REQUEST §R1 |   5    |   5    |   ✓    |   ✓    |
| 4   | Commission & Clawback Reactivity         | ORIGINAL_REQUEST §R2 |   5    |   5    |   ✓    |   ✓    |
| 5   | Group, Status, Payouts & Tags Reactivity | ORIGINAL_REQUEST §R2 |   5    |   5    |   ✓    |   ✓    |

## Test Architecture

- Test Runner: Vitest v4.0.8 (`apps/web/vitest.config.ts`)
- Test Target: `apps/web/tests/weletic/swr-reactivity-invalidation.test.ts`
- Verification Semantics:
  - Assert that `mutatePartner`, `mutatePrefix`, `mutateComposite`, `mutateDiscountCodes`, `mutatePartnerLinks`, `mutateCommissions` match all composite and non-composite query strings.
  - Assert cache state updates immediately upon mutation execution.
  - Assert TypeScript compilation (`pnpm --filter web exec tsc --noEmit`) passes cleanly with 0 errors.

## Real-World Application Scenarios (Tier 4)

| #   | Scenario                                                     | Features Exercised | Complexity |
| --- | ------------------------------------------------------------ | ------------------ | ---------- |
| 1   | Partner Link Creation & Instant Row Render                   | F1, F2             | Medium     |
| 2   | Discount Code Lifecycle & Button Disabled State              | F1, F3             | Medium     |
| 3   | Commission & Clawback Creation Updating Partner Header Stats | F1, F4             | Medium     |
| 4   | Group Change & Payout Confirmation Sync                      | F1, F5             | Medium     |
| 5   | Full Partner Lifecycle End-to-End Reactivity                 | F1, F2, F3, F4, F5 | High       |

## Coverage Thresholds

- Tier 1: ≥5 per feature (≥25 test cases)
- Tier 2: ≥5 per feature boundary/corner conditions (≥25 test cases)
- Tier 3: Pairwise combinations of resource mutations and composite queries (≥10 test cases)
- Tier 4: ≥5 realistic end-to-end partner lifecycle workflows (≥5 test cases)
- Target Total: ≥65 new comprehensive reactivity test cases + 864 baseline tests = ≥929 passing tests.
