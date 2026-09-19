# Thank you exact-integer build compatibility

September 20, 2026; base public main `a6965d65079cd57fc15f558d977bace14790f4c0`.
Addresses the BigInt-literal build risk retained in PR #90, within L07/S03.

The Thank you entry used three BigInt literals while the extension build targets
ES2015 syntax. A direct Vite/esbuild ES2015 transform of the base revision fails
at all three literals. Replaced only these literals with `BigInt` constructor
calls, using strings for signed-64 bounds. No Number conversion, rounding,
balance contract, authentication, network endpoint or extension identity changes.

Verification:

- New ES2015 transform regression passes with no warnings; both exact bound
  strings remain in the output. This is a syntax test, not a runtime polyfill.
- Existing actual-component tests preserve signed-64 boundaries, values above
  Number's safe range, invalid input rejection, EN/JA/VI presentation, unknown
  pending balance, auth failure and absence of private identifiers in DOM.
- Shopify package suite: 192 tests in six files passed.
- Shopify typecheck and Remix production build passed. Existing sourcemap,
  Vite CJS and React Router future-flag warnings remain unrelated and unresolved.

No CLI deployment, extension publication, shopper request or live mutation was
performed. Shopify's installed sandbox must still prove `BigInt` and localized
formatting support, real session/network access and the complete Thank you
journey. The Plus-only checkout target remains excluded from public staging.
This does not close L07/S03 or production readiness.
