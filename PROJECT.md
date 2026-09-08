# Project: Weletic Room Webhook Provisioning, Admin Sync, & Compare-at Pricing

## Architecture

- **Webhooks Subsystem**: `apps/web/lib/weletic/shopify/provision-webhooks.ts`, `apps/web/app/(ee)/api/shopify/integration/callback/route.ts`, `apps/web/app/(ee)/api/shopify/integration/webhook/route.ts`.
- **Admin 1-Click Sync**: `apps/web/app/(ee)/api/shopify/integration/sync/route.ts`, `apps/web/lib/actions/partners/sync-shopify-catalog.ts`, `apps/web/lib/weletic/shopify/catalog-sync.ts`, `apps/web/lib/weletic/redis-lock.ts`, `apps/web/lib/integrations/shopify/ui/settings.tsx`.
- **Compare-at Pricing & Badges**: `apps/web/lib/weletic/money.ts`, `apps/web/lib/swr/use-weletic-products.ts`, `apps/web/app/(ee)/partners.dub.co/(dashboard)/programs/[programSlug]/(enrolled)/products/page-client.tsx`, `product-detail-modal.tsx`, `[productId]/page-client.tsx`, `product-offer-link-modal.tsx`.
- **Test Infrastructure**: `apps/web/tests/weletic/`, Vitest test runner, TypeScript `tsconfig.json`.

## Feature Inventory

| #   | Feature                                 | Description                                                          | Milestone | Status |
| --- | --------------------------------------- | -------------------------------------------------------------------- | --------- | ------ |
| 1   | Automated 12-Topic Webhook Provisioning | `ensureShopifyWebhooksRegistered` helper with 12 canonical topics    | M1        | DONE   |
| 2   | OAuth Callback Auto-Provisioning        | Automatic registration on store connection/re-authentication         | M1        | DONE   |
| 3   | Dynamic Callback URL Resolution         | Multi-environment URL resolver (dev tunnel, prod, custom)            | M1        | DONE   |
| 4   | Webhook Idempotency Handling            | Graceful skip on existing subscriptions without 400/500 errors       | M1        | DONE   |
| 5   | Admin 1-Click Sync Endpoint             | `POST /api/shopify/integration/sync` with workspace auth             | M2        | DONE   |
| 6   | Distributed Lock Protection             | Redis atomic lock `weletic:catalog-sync:${workspaceId}` with 30m TTL | M2        | DONE   |
| 7   | Admin UI Sync Button & States           | "Sync Catalog Now" button with spinner, timestamp, toast             | M2        | DONE   |
| 8   | Instant SWR Invalidation                | SWR cache mutation for products, markets, and partner cards          | M2        | DONE   |
| 9   | Localized Compare-At Models & Types     | `WeleticCatalogVariant` & `compareAtAmount` in SWR types             | M3        | DONE   |
| 10  | Money Compare-At Formatting & Badges    | `formatCompareAtPrice` & discount percent calculation helper         | M3        | DONE   |
| 11  | Catalog Grid Strikethrough & Sale Badge | Strikethrough price + `-XX%` badge in `ShopeeProductCard`            | M3        | DONE   |
| 12  | Product Detail Modal Pricing            | Strikethrough price + sale badge in detail modal                     | M3        | DONE   |
| 13  | Standalone Product Page Pricing         | Strikethrough price + sale badge in product page hero box            | M3        | DONE   |
| 14  | Product Offer Link Modal Summary        | Product thumbnail + price + strikethrough preview                    | M3        | DONE   |
| 15  | Vitest Test Suite Verification          | 100% pass across all 83 test files (1,103 tests) in `tests/weletic/` | M4        | DONE   |
| 16  | TypeScript Compilation Guardrails       | Zero errors under `pnpm tsc --noEmit`                                | M4        | DONE   |

## Milestones

| #   | Name                                           | Scope                                                                       | Dependencies | Status |
| --- | ---------------------------------------------- | --------------------------------------------------------------------------- | ------------ | ------ |
| 1   | M1: Webhook Provisioning Subsystem (R1)        | Helper, 12 topics, OAuth callback, dynamic URL, idempotency, unit tests     | none         | DONE   |
| 2   | M2: Admin 1-Click Sync Action & UI (R2)        | `POST /api/shopify/integration/sync`, distributed locking, settings UI, SWR | M1           | DONE   |
| 3   | M3: Compare-At Strikethrough Pricing & UI (R3) | SWR types, money helpers, 4 UI components (Grid, Modals, Detail page)       | none         | DONE   |
| 4   | M4: Final Verification & Test Guardrails (R4)  | 100% Vitest pass across all suites, TypeScript validation, audit            | M1, M2, M3   | DONE   |

## Code Layout

- `apps/web/lib/weletic/shopify/provision-webhooks.ts`: Webhook provisioning service
- `apps/web/app/(ee)/api/shopify/integration/callback/route.ts`: OAuth callback
- `apps/web/app/(ee)/api/shopify/integration/sync/route.ts`: Admin 1-click sync API
- `apps/web/lib/actions/partners/sync-shopify-catalog.ts`: Next safe action
- `apps/web/lib/integrations/shopify/ui/settings.tsx`: Admin integration settings UI
- `apps/web/lib/weletic/money.ts`: Money formatting and discount helpers
- `apps/web/lib/swr/use-weletic-products.ts`: Catalog SWR hook and types
- `apps/web/app/(ee)/partners.dub.co/(dashboard)/programs/[programSlug]/(enrolled)/products/`: Partner portal UI
- `apps/web/tests/weletic/`: Vitest test suites (83 files, 1103 tests)
