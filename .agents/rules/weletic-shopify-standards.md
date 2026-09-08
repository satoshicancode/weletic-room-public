# Weletic Shopify Integration & Financial Standards

These architectural standards and invariants MUST ALWAYS be followed when working with Weletic Room, Shopify APIs, and financial commission calculations:

## 1. Financial Precision & Line-Item Integrity (ADR 0004)

- **Line-Level Settlement:** Any commission calculation involving Shopify items MUST be evaluated at the individual line-item level.
- **No Global Leakage:** Never apply item-specific reward rates or discounts to unrelated cart items or the entire order amount.
- **Integer Minor Units:** All monetary arithmetic must use integer `BigInt` minor units (cents, yen) using `divideAndRound` to prevent IEEE 754 floating-point drift.
- **Specificity Precedence:** Always resolve conflicting conditions via `Variant (4) > Product (3) > Collection (2) == Tag (2) > Partner Group Base (1) > Program Fallback (0)`.

## 2. Domain & Token Session Resilience

- **Dual-Domain Resolution:** All backend queries for Shopify stores must search across both `shopifyStoreId` and `shopDomain` to support development aliases (e.g. `montdev` and `yamaxdev`).
- **Resilient Encryption:** Token encryption and decryption utilities must transparently accept both 64-character Hex strings and Base64-encoded buffers.

## 3. Zero-Conflict Upstream Upgradability

- **Preserve Core Schema:** Never modify Dub's core database models for Shopify attributes; always store extended activewear/e-commerce rules in JSON fields (`Reward.modifiers`, `Reward.conditions`).
- **Modular Isolation:** Keep Weletic-specific domain logic and components in dedicated directories (`lib/weletic/...`, `ui/weletic/...`).
