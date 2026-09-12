# Public extension reconciliation — September 10, 2026

Read-only source inventory after ADR 0029. No extension UID was generated,
registered, deployed or reassigned by this audit. The public manifest still has
`extension_directories = []`; existing local UIDs are not public ownership evidence.

Subsequent [offline staging implementation](public-extension-staging-2026-09-10.md)
records the local package, tests and a CLI validation result rejected because of a
custom/public UID collision. The original inventory below remains the target scope.

## Exact inventory and disposition

All source paths below are relative to `packages/shopify-app/extensions/`.

| Source directory                  | Public staging disposition                               | Remaining work                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `weletic-customer-account`        | Include with new public-owned identity                   | Replace legacy API origin; build/validate; protected-data/network access and live account hub acceptance                                       |
| `weletic-customer-account-blocks` | Include with new public-owned identity                   | Replace legacy API origin; build/validate; protected-data/network access and live profile-block acceptance                                     |
| `loyalty-checkout-slider`         | Stage thank-you target only with new public identity     | Keep `purchase.thank-you.block.render`; exclude `purchase.checkout.reductions.render-after` and its checkout module; replace legacy API origin |
| `weletic-analytics`               | Stage loyalty-only theme subset with new public identity | Include launcher/embed, landing page and product points; exclude review blocks/assets; verify asset dependency closure                         |
| `weletic-points-earned`           | Stage with new public-owned identity                     | Preserve payload fields/handle; prove actual workflow execution                                                                                |
| `weletic-vip-tier-changed`        | Stage with new public-owned identity                     | Preserve payload fields/handle; prove actual workflow execution                                                                                |
| `weletic-reward-redeemed`         | Stage with new public-owned identity                     | Preserve payload fields/handle; prove actual workflow execution                                                                                |
| `weletic-points-expiring-soon`    | Stage with new public-owned identity                     | Preserve payload fields/handle; prove actual workflow execution                                                                                |
| `weletic-referral-completed`      | Stage with new public-owned identity                     | Currently no UID; preserve payload fields/handle; prove actual workflow execution                                                              |
| `weletic-flow-lifecycle`          | Stage with new public-owned identity                     | Replace legacy callback URL; verify lifecycle activation/deactivation ownership                                                                |
| `weletic-free-product`            | Exclude from current public package                      | Existing Function must not silently replace the approved native Basic discount strategy                                                        |
| `weletic-pos-loyalty`             | Exclude from loyalty-focused release                     | POS remains out of scope                                                                                                                       |

Twelve source extension manifests were found; eleven contain existing UIDs. None
can be assumed to belong to the public registration. A staff-authorized points
adjustment Flow action is a separate unfinished implementation, not one of these
twelve existing extensions.

## Confirmed routing changes

- `weletic-customer-account/src/CustomerAccountLoyalty.tsx` and
  `weletic-customer-account-blocks/src/CustomerAccountLoyaltyBlocks.tsx` use
  `https://shopify.weletic.com/api/customer-account/loyalty`.
- `loyalty-checkout-slider/src/ThankYou.tsx` uses
  `https://shopify.weletic.com/api/checkout/loyalty/customer`.
- `weletic-flow-lifecycle/shopify.extension.toml` uses
  `https://app.weletic.com/api/shopify/flow/lifecycle`.

Public staged UI copies must use the corresponding paths at
`https://loyalty-shopify-dev.weletic.com`; the staged Flow callback must use
`https://loyalty-api-dev.weletic.com/api/shopify/flow/lifecycle`. Preserve the
custom app's source defaults and existing identities. Reject unexpected source
contents instead of silently applying broad string replacements.

## Theme subset

The theme currently contains five blocks. Retain `app-embed.liquid`,
`loyalty-landing.liquid` and `product-points-preview.liquid`. Do not stage
`product-reviews.liquid`, `product-review-stars.liquid`, `weletic-reviews.js` or
`weletic-reviews.css`. Determine the retained blocks' asset/snippet dependency
closure before packaging; do not assume every other asset is required or safe.
The retained launcher must still satisfy EN/JA/VI, mobile, wallet and privacy gates.

### Dependency-closure follow-up

Source inspection of the three retained blocks finds five loyalty asset dependencies:
`weletic-loyalty-styles.css`, `weletic-loyalty-shared.js`,
`weletic-loyalty-widget.js`, `weletic-loyalty-landing.js` and
`weletic-product-points.js`. No retained block references a snippet or review asset.
The landing script's branding image URL is runtime content, not a bundled asset.

The current `app-embed.liquid` additionally includes `weletic-tracker.js` behind
`enable_conversion_tracker`, which defaults to true, with partner attribution and
automatic partner-discount settings. A loyalty-only staged embed must omit that
script branch and those four partner controls (header, tracker toggle, automatic
discount toggle and custom tracking domain), without altering the custom source.
Assert that the staged manifest has only the five loyalty assets and that no
partner tracking or review block is emitted. Preserve all loyalty settings.

Two shopper gaps must not be mistaken for completed localization/earning evidence:
the landing Liquid still contains hardcoded English loading/authentication copy;
the product-points Liquid initially renders a fabricated 1x estimate before the
JavaScript can replace it. Follow-up acceptance must cover pre-hydration and script
failure states, not only the hydrated browser. These findings do not authorize
changing accounting rates or claim that theme staging has been implemented.

## Implementation and acceptance requirements

1. Build an isolated public staging directory from an explicit source allowlist.
   Preserve custom files byte-for-byte. Refuse a destination inside either custom
   source tree or any existing deployment directory; never overwrite unknown work.
2. Obtain public-specific UIDs in the selected public-app context. Persist the
   resulting mapping so rebuilds do not rotate identities. CLI schema validation
   alone does not establish remote ownership; retain named registration evidence.
3. Test exact target/handle inventory, endpoint paths, UID uniqueness and disjointness
   from custom UIDs, exclusion of POS/checkout-reductions/Function/review surfaces,
   expected source hashes or exact source anchors, and dependency closure.
4. Build and validate the isolated package; report missing prerequisites separately
   from source defects. Never validate in the custom extension tree, because CLI
   validation can insert a missing UID.
5. Publish only at the deployment gate. Confirm no pending/unapproved installation
   can activate writers. Complete install/reinstall, customer-data/network and real
   Flow/shopper acceptance before declaring A4 or release readiness complete.

This inventory specifies the next implementation; it does not close A4 or any
live acceptance requirement.
