# Yamaxdev shopper acceptance checkpoint — September 17, 2026

Scope: Hiro approved one disposable customer/product/reward, two test-mode
orders, redemption, discount use and refunds, with targeted cleanup. Production,
real payments, real emails and changes to the retained custom app are excluded.
This checkpoint is **not** an accepted financial or authenticated shopper journey.

## Observed and executed

- Shopify Admin identifies this as a non-transferable development store and shows
  a Test payment gateway. No payment-provider configuration was changed.
- The installed public app's App Proxy URL is `/apps/weletic-1`. The theme block's
  configurable proxy prefix supports this; `/apps/weletic` was not reassigned.
- A loyalty-only theme extension was staged using the reviewed allowlist, without
  inherited custom identities. CLI configuration validation passed. CLI preview
  and the theme editor both identify it under **Weletic Loyalty Reviews Dev**.
  Its local UID is disjoint from all retained custom extension UIDs. This proves
  a development preview, not a released app version or all-extension ownership.
- The preview host is the existing draft **App Ext. Host
  (12a739-Hiros-Super-iMac)**. Only the public launcher was configured with the
  installed proxy prefix. The custom app's embed and configuration were unchanged;
  no theme was published.
- The first temporary tunnel inherited machine-wide ingress rules and returned 404. Restarting it with explicit empty configuration restored app forwarding.
  The backend's internal session route still returned 404 through public ingress.
  No TLS verification, authentication or gateway check was disabled.
- The authenticated merchant editor created `loyalty-acceptance-20260917-a`
  through the signed configuration gateway. Independent SQL confirmed `draft`,
  one point per JPY, zero pending days, zero expiry and both expiry warnings off.
- The reward editor created `loyalty-acceptance-20260917-a-fixed`: inactive,
  fixed amount, 100 points for JPY 100, one-time purchases, one use per code.
  No Shopify discount was issued. Independent SQL confirmed the values and zero
  loyalty accounts, redemptions and ledger entries.

## Defect found and regression repair

The configuration editor removed its form during SWR background revalidation.
Refocusing the live page could therefore erase unsaved fields. The editor now
remains mounted during revalidation with writes disabled. Failed authorization
still hides it; changed scope, installation generation or configuration revision
still replaces stale state. No API, accounting, schema or authorization change.

Both draft and existing-program regressions failed before the fix, then passed.
Tests also cover no submission during revalidation, revision replacement and
authorization failure. The focused editor/contract/state suites passed 58 tests;
independent adversarial review found no blockers. Real browser creation of the
named draft succeeded with its edited name and warning settings preserved.
Web and Shopify typechecks, focused lint, formatting, Prisma validation, the
Shopify build and the full web production build (372 static pages) passed.

The public launcher was disabled again on the draft theme while awaiting shopper
authentication. Its correct proxy prefix is retained; the program remains draft
and the reward inactive. No app was uninstalled or development preview deleted.

## Remaining execution boundary

Shopify customer accounts use native email sign-in. No test email has yet been
designated, and the approved scope excludes real emails. Do not create a shopper
session from an Admin token, fabricate App Proxy customer identity, switch account
types, or substitute a mocked login. Ask for a dedicated test email and permission
for Shopify's authentication code only; keep transaction/marketing/loyalty delivery
disabled. The native sign-in page was opened, but no email or code was submitted.

After that boundary is resolved: verify the exact customer identity, create the
single disposable product, configure bounded purchase earning, activate only for
the supervised test, execute the two checkouts and refunds, independently reconcile
SQL and Shopify state, then disable the program and clean up exact fixtures.
No purchase, earning, redemption, discount use or refund has passed at this point.
