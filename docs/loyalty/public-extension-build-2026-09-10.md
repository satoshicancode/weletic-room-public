# Public extension build — September 10, 2026

Build follow-up to [offline staging](public-extension-staging-2026-09-10.md).
No deployment, installation, live Shopify mutation or customer-data access occurred.

## Passed local gates

The ten-extension package was validated and built in fresh private OS-temporary
directories, never in the retained custom tree. `shopify app config validate --json`
returned `valid: true`, `issues: []`. `shopify app build` installed the two declared
dependencies in the temporary package, bundled all three UI extensions and ran
Theme Check/bundling for the loyalty-only theme. The command exited successfully.
Flow manifests were included in configuration validation; this is not workflow
publication or execution evidence.

The first build used staging commit `48c21db993`. After the initial-display fix
below, a fresh package again passed validation/build. An independent local audit
verified that all ten UIDs remained identical to the recorded candidate mapping,
were unique, and were disjoint from all eleven retained custom UIDs. Candidate
stability and disjointness do not establish remote ownership.

The three final JavaScript artifacts each contain the public API origin and no
legacy `https://shopify.weletic.com/api/` endpoint:

| Bundle                                 | Bytes | SHA-256                                                            |
| -------------------------------------- | ----: | ------------------------------------------------------------------ |
| `weletic-public-loyalty-thank-you`     | 14175 | `1e326b1a43a15f8113b80cb95ce69da212cd092ba832a236d4661632513771bf` |
| `weletic-loyalty-customer-account-hub` | 44063 | `e6ea38f26bd85d0b2f12d84ba0f3777e81932474450bb62a78dc5bdbaec157ca` |
| `weletic-loyalty-account-blocks`       | 15880 | `be1ef332c6cfed81507d417c6d545612532415b46ecbc74e9e666e39ed83ed96` |

## Product-points initial display correction

The public staging transformation removes the original Liquid 1x-price calculation
and renders an em dash until the existing JavaScript receives the configured base
rate. It does not change earning arithmetic, policy, API contracts or custom source.
The placeholder remains correct when scripts are disabled, requests are delayed
or the transport fails; no promised points amount is fabricated.

Three actual staged-fragment/asset tests cover initial markup without JavaScript,
pending response followed by base-rate display, and transport rejection. Surrounding
price/currency inputs and transport are synthetic; happy-dom is not a real browser
or live Shopify acceptance. Together with staging and existing theme-asset suites,
36 tests passed. Web typecheck, root lint and formatting passed. No claim is made
that full EN/JA/VI product-point, variant, VIP/campaign or earning acceptance is done.

## Still open

September 12 revalidation after integrating public main `2c9a37ac19`: a fresh
34-file stage passed CLI configuration validation (`valid: true`, no issues) and
the app/extension build. Independent inspection found ten unique staged IDs,
all disjoint from the eleven retained custom IDs. The stage was outside Git in
an OS-temporary directory; no extension identity or configuration was published.
This refreshes local build evidence only and does not close any live gate below.

- Authoritative public registration/UID mapping and approved deployment.
- Backend namespace/credential isolation and public endpoint reachability.
- Protected customer data/network access and real account/thank-you rendering.
- Named `yamaxdev` install/reinstall, Flow and points → redemption → checkout →
  refund evidence. Neither CLI success nor app-info local metadata proves these.
- Remaining localization, accessibility, initial landing-page text and full shopper
  surface acceptance. The broader loyalty goal is unchanged.
