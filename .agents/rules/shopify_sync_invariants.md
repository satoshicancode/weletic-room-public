---
title: Shopify Multi-Domain & Soft-Delete Architectural Invariants
trigger: always_on
---

# Shopify Multi-Domain & Soft-Delete Architectural Invariants

## 1. Shopify Store Identity & Webhook Resolution

- Always resolve incoming Shopify requests (webhooks, callbacks, auth, cron reconciliation) using the canonical resolver (`resolveShopifyStoreByDomain`) rather than direct strict string matching on `shopifyStoreId`.
- Support multiple domain aliases (`myshopifyDomain`, `primaryDomain`, custom domains) seamlessly pointing to the same workspace without hardcoded domain checks.

## 2. Soft-Delete Coherence Invariant

- Whenever soft deletion (`disabledAt`) is used for relational records (e.g., `DiscountCode`):
  1. **API Queries**: Include `where: { disabledAt: null }` in all Prisma relation queries and endpoints returning active collections.
  2. **UI Tables**: Filter out records where `disabledAt !== null` unless explicitly rendering an audit/history view.
  3. **Uniqueness & Creation**: Uniqueness checks for new resource creation must ignore or auto-purge soft-deleted/disabled records so users can re-use identifiers without collision/conflict errors.

## 3. Background Daemon Lifecycle

- When updating backend utilities that are consumed by long-running background workers (such as sync pollers or cron daemons), always restart the daemon process to guarantee execution of the latest compiled code.

## 4. Multi-Tenant Architecture & Zero-Hardcoding Invariants

- **Zero Hardcoding**: NEVER hardcode specific store domains (e.g. `yamaxdev.myshopify.com`, `montdev`), workspace IDs, user IDs, or static collection IDs in application logic, fallback handlers, GraphQL queries, or discount providers.
- **Universal Auto-Provisioning**: Webhook registrations (`ensureShopifyWebhooksRegistered`) and catalog reconciliation must be automatically provisioned for every tenant/workspace upon installation or re-authentication.
- **Dynamic Context Resolution**: Always derive store domains, access tokens, and accounting currencies directly from the authenticated `workspace` / `installedIntegration` / `WeleticShopifyStore` records.
