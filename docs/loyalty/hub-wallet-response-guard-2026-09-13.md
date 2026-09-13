# Customer-account hub wallet response guard — September 13, 2026

## Defect and bounded change

The customer-account hub accepted the customer summary directly into state.
A non-array wallet failed at `.filter()`, while a null entry failed when reading
its status. These failures occurred during render, outside the request error
handler, preventing the existing localized retry experience.

The summary loader now rejects malformed wallet containers and entries before
updating state. Missing and null wallets remain compatible empty wallets.
Unknown string statuses retain existing history behavior. This is a collection
boundary guard, not full validation of every nested summary or reward term.

## Evidence and limits

`packages/shopify-app/test-support/account-hub-locales.test.ts` renders the actual
Preact hub in jsdom with a mocked Shopify host and synthetic responses. It covers
non-array wallets, null/array entries, missing/non-string statuses, localized
EN/JA/VI error and retry recovery, and absent/null/empty wallet compatibility.
Existing redemption tests remain in the same suite.

No API, schema, authentication, accounting, reward-policy or issuance contract
changes. No deployment, real customer access, order, redemption or email occurred.
This checkpoint does not satisfy named `yamaxdev` live acceptance, mobile visual
acceptance, or full loyalty launch gates.
