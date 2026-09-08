# Weletic Room Platform Architecture

## Objective

**Weletic Room** is a cross-border Social Commerce & Creator Platform inspired by Rakuten Room, built on top of a licensed Dub Enterprise engine. Dub serves as the high-throughput attribution, tracking, and partner-operations core.

Weletic Room introduces public creator storefronts ("Rooms") at `room.weletic.com/{creatorSlug}` (e.g. `https://room.weletic.com/pickleball-channel`), multi-currency Shopify Markets catalog integration, line-level commission rules, and international payout localization.

---

## Domain Architecture Matrix

| Domain                     | Role & Purpose                                                                                                                       | Target Audience              |
| :------------------------- | :----------------------------------------------------------------------------------------------------------------------------------- | :--------------------------- |
| **`room.weletic.com`**     | **Creator Public Rooms:** Social storefronts where creators showcase and recommend their favorite curated Weletic/Yamax products.    | End Consumers / Followers    |
| **`partners.weletic.com`** | **Partner & Creator Portal:** Dashboard for KOCs and Affiliates to manage links, track commissions, and setup payout profiles.       | Creators / KOCs / Affiliates |
| **`app.weletic.com`**      | **Merchant & Business App:** Workspace console for brand owners to configure reward tiers, manage groups, and sync Shopify catalogs. | Brand Owners / Merchants     |
| **`admin.weletic.com`**    | **Platform Super-Admin:** Global management console for operations, cross-border FX tables, and financial reconciliation.            | Weletic Operations Team      |

---

## Source Ownership & Architecture Standards

- `origin` is the private Weletic downstream (`weletic-room`).
- `upstream` is `dubinc/dub` and is fetch-only.
- Weletic-specific database models, APIs, and symbols use `Weletic` or `weletic` prefixes.
- Enterprise modules stay private and must not be leaked to public remotes.

---

## Money Contract

Each program has one configurable accounting currency (`USD` initially). Commerce records preserve:

1. **Presentment money:** The exact currency and amount charged to the customer at checkout (VND, JPY, USD, EUR, etc.).
2. **Shopify shop money:** The default store base currency.
3. **Accounting money:** The unified program currency used for commission calculations, rules, and ledger reporting.
4. **Payout money:** The target settlement currency quoted and paid to the creator via Wise, PayPal, or local bank rails.

---

## Localization Contract

- **English (`en`)**: Source and fallback locale.
- **Vietnamese (`vi`)**: Native locale for creators and customers in Vietnam.
- **Japanese (`ja`)**: Native locale for Japan cross-border commerce.
