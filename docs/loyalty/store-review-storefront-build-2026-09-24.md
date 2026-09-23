# Store-review storefront build check — September 24, 2026

Scope: local build evidence for public `main`
[`0bdae1b0`](https://github.com/satoshicancode/weletic-room-public/commit/0bdae1b0c72f1d78ad940d1222f460008446d1cf).
This does not establish an installed public-app extension or close SR-07.

| Check                        | Result                                                                                                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generated review theme asset | `pnpm --filter @weletic/shopify-app check:theme-assets` passed; `weletic-reviews.js` is 8,419 bytes, below the 10 KB asset limit. The asset matched its readable source.                                         |
| Shopify build                | Shopify CLI 4.8.0 `shopify app build --no-color --skip-dependencies-installation` passed from `packages/shopify-app` with the default app config. It built the theme, UI extensions, function and Remix web app. |
| Storefront behavior          | `review-theme-asset.test.ts` and `store-review-storefront.test.ts`: 5 tests passed.                                                                                                                              |
| Repository state             | The build left no tracked changes; the pre-existing local acceptance-matrix edit was preserved.                                                                                                                  |

The default app configuration builds the existing extension identities. The
separate `shopify.app.loyalty-public.toml` deliberately points to an empty
extension directory until public-owned extension identities are reconciled.
This check therefore does **not** prove public-app extension ownership,
installation, grants, published theme placement, 375px/keyboard behavior or
shopper/provider delivery. Those remain in the installed SR-01–SR-07 packet.
