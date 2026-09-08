# ADR 0002: Launch locales English, Vietnamese, and Japanese

- Date: 2026-08-14
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Weletic Partners will serve creators in multiple countries and must localize
the partner portal, program content, transactional communication, product
catalog, dates, numbers, and currencies. Dub currently contains mostly English
UI strings and only isolated translation helpers rather than an application-wide
internationalization system.

Implementing every Shopify-published locale at launch would increase
translation, QA, support, and release coordination before usage data identifies
the highest-value markets. Starting with only English would delay validation of
fallback behavior and non-English layouts, making later expansion riskier.

## Decision

Weletic Partners will launch its platform UI in English, Vietnamese, and
Japanese. English is the source and fallback locale. Locale identifiers will
use BCP 47 conventions, with initial locale selection derived from an explicit
user preference, then profile preference, cookie, browser language, and finally
the English fallback.

The localization architecture must accept additional locales without database
schema changes. Weletic-owned interface text will use version-controlled message
catalogs, while translated Shopify product and collection content will remain
Shopify-owned and be synchronized for the requested market and locale.

## Alternatives considered

- **All Shopify-published locales at launch** — Deliver maximum initial
  coverage. Rejected because translation and QA cost would be disproportionate
  before partner-market demand is known.
- **English-only launch** — Minimize initial implementation. Rejected because it
  would not validate the multilingual architecture required by the product.

## Consequences

### Positive

- The launch validates Latin and Japanese-script layouts plus locale-aware
  formatting from the first release.
- Translation and QA scope remains manageable for a startup team.
- Future locales can be added through message catalogs and Shopify data rather
  than schema changes.

### Negative / trade-offs accepted

- Partners using other languages initially receive the English fallback.
- Every partner-facing email, notification, validation message, and financial
  display must participate in the localization system.
- Translation completeness and fallback behavior become release-quality gates.

### Follow-ups

- Introduce a type-checked application-wide internationalization layer.
- Add English, Vietnamese, and Japanese message catalogs.
- Store preferred locale and time zone on the partner/user profile.
- Localize emails, dates, numbers, currencies, and program content.
- Synchronize Shopify global and market-specific product translations.
- Add automated missing-key, fallback, and layout tests for all launch locales.

## References

- Hiro approval in the Weletic Partners architecture discussion on 2026-08-14.
- https://nextjs.org/docs/app/guides/internationalization
- https://shopify.dev/docs/apps/build/markets/manage-translated-content
