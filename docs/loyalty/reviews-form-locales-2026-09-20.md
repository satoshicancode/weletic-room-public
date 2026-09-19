# Review invitation form — local EN/JA/VI checkpoint

Date: September 20, 2026 (Asia/Tokyo). Part of R01/R02 in the
[combined checklist](company-store-completion.md), not completion of either task.

## Implemented behavior

- The existing signed app-proxy form accepts only `en`, `ja` or `vi` as its
  optional initial locale, with English fallback. In-page switching requires no
  navigation/request and preserves entered content, rating, photos and consent.
- Labels, instructions, consent, loading, validation and result states are
  localized. Native browser validation follows the browser's own locale.
- Server error bodies are never displayed. Only fixed localized messages are
  used, including an explicit uncertain submission state. Unknown or malformed
  success responses cannot falsely acknowledge a published review.
- A synchronous guard blocks concurrent submissions. Successful and uncertain
  submissions stay locked; definite validation failures preserve input for
  correction. Uploaded media are reused when a definite validation failure is
  corrected in the same visit.
- Invitation token remains in a closure, not DOM/storage/query; the fragment is
  removed before the first request. Existing signed gateway, nonce CSP, no-store
  response, consent requirement and backend single-use token remain unchanged.

## Evidence

- 80 tests across six focused production form/gateway/service/contract/policy
  suites passed. Tests cover all locales, one-star submissions, language changes,
  invalid/expired invitations, consent, malformed previews, concurrent submit,
  network/non-JSON/unknown acknowledgements, untrusted product/server content,
  unsupported locale, invalid photos and uploaded-photo retry reuse.
- Real Chromium drove production HTML/JavaScript through the existing loopback
  preview harness at 375 x 812. JA → VI → EN switching retained a one-star rating
  and typed content. Each locale had no horizontal overflow; the bearer was absent
  from the DOM and address bar. Keyboard Tab/Space/Enter completed consent and
  submission, with the expected pending-moderation result.
- Browser transport, product and submission persistence were synthetic. This
  did not exercise Shopify HMAC, live invitations, database writes or real media
  processing. The synthetic image test is transport/cache evidence, not decoding
  or upload security acceptance. Full screen-reader/theme acceptance remains open.
- Independent adversarial review found no blocking defect and requested the
  additional malformed/network/photo-retry cases included above.
- Web/Shopify types and production builds, 191 Shopify unit tests, focused lint,
  Prisma validation, Prettier and whitespace checks passed. The web build used
  the isolated loyalty-only build environment, not live credentials; this is
  not proof that reviews are admitted by the production release allowlist.
- The task browser and loopback preview server were stopped after verification.
  Generated artifacts remain local and are excluded from publication.

No schema, policy activation, module enablement, loyalty account, order, reward,
email, Shopify publication or deployment changed. Exact prospective incentive
disclosure and authenticated policy activation remain R04; this localization
preserves the existing generic reward notice and does not claim those are done.
