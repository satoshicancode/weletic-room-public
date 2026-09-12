# Landing locale and mobile acceptance — September 13, 2026

## Scope and provenance

Local presentation correction for backlog L09, not live Shopify acceptance.
The browser fixture served the actual shared helper, landing controller and CSS
from this branch with synthetic program/customer responses. Its HTML mirrored
the landing block structure; it did not execute Shopify Liquid or authentication.
No store configuration, deployment, order, referral claim, redemption or email
was changed. Merchant-authored names, descriptions, perks and branding remain
unchanged; interface copy uses EN/JA/VI with English fallback.

## Defects and corrections

- Japanese document language previously left all landing interface copy English.
  The controller now selects the block locale before document language, accepts
  regional language tags and localizes loading, account, earning, VIP, reward,
  referral and error states. Liquid supplies locale and localized first-paint
  loading/authentication text; live Liquid rendering remains unverified.
- A long synthetic referral link expanded a 375px viewport to 698px. Link wrapping,
  balance wrapping and container sizing now keep the measured document width at
  375px. Guest actions wrap rather than forcing a single row.
- Shared formatters accept optional locale/translation context without changing
  existing callers or integer arithmetic. Review caught default Intl rounding of
  four-decimal VIP multipliers; explicit four-decimal precision and regressions
  now preserve both 1.2345 and 1.0001.

## Observed browser evidence

Chrome, 375 × 812, September 13 approximately 05:34–05:38 JST:

| Fixture             | Observed result                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| EN, JA, VI member   | Localized headings, exact 9,007,199,254,740,993 balance (locale-specific separators), 375px document width, no private identifier sentinels in DOM |
| JA keyboard         | Tab then Enter activated referral-copy and displayed Japanese success text                                                                         |
| VI guest            | Localized register/login/referral-login links; 375px document width                                                                                |
| JA suspended member | Balance retained, localized participation warning, no referral URL or copy button                                                                  |
| VI program failure  | Localized alert/retry while retaining independently loaded member balance; retry returns the same synthetic error                                  |
| JA paused program   | Localized unavailable message; no earning/referral actions                                                                                         |

Screenshots were visually checked for EN/JA/VI. They remain local test artifacts,
not copied Smile assets or public customer evidence.

## Remaining acceptance

- Live Liquid rendering, real theme spacing, Shopify locale switching and signed
  App Proxy authentication on `yamaxdev` remain open.
- This check does not establish referral friend claiming, qualification, rewards,
  abuse handling or clawback. No referral transaction was performed.
- Clipboard failure/reset, every state in every language, full screen-reader
  coverage and all other storefront surfaces still require named evidence.
- The broader L09 and launch gates remain unchecked. Local test/build evidence
  and PR CI must pass independently before these changes are treated as shipped.

## Local validation checkpoint

- Full web unit suite: 497 files, 8,029 passed and six skipped. It uses CI fixture
  values; an earlier invocation without the dummy Shopify app ID failed before
  this complete successful rerun.
- Web typecheck passed with the repository CI's 8GB heap setting. The first
  default-heap attempt exhausted memory; no type error was suppressed.
- Repository lint, changed-file formatting, JavaScript syntax, Prisma schema
  validation and Shopify package typecheck/build passed.
- The first Next build compiled and validated types but failed static-page
  generation against an unusable dummy database connection. A separate,
  previously approved empty isolated database is used for the read-only rerun;
  the rerun passed compilation, type validation, static generation and tracing.
  Its temporary SELECT grant was revoked and independent SQL confirmed all 157
  fixture tables empty afterward. This is not a deployed or live-store build.
