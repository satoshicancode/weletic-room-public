# S22: retained accounts with locally confirmed points-funded issuance

The merchant analytics snapshot now has a separate monthly series for retained
accounts whose points-funded reward issuance was confirmed by the app. It uses
`WeleticRewardRedemption.issuanceConfirmedAt`, counts each account once per UTC
month, and classifies that account as returning when a qualifying retained
confirmation precedes its first in-range month. It excludes zero-point/direct
awards, foreign stores and Shopify-redacted accounts. Counts are exact decimal
strings in the signed snapshot and CSV/JSON exports; the UI labels the series in
English, Japanese and Vietnamese.

This is **not** a lifetime shopper or successful-use cohort. The timestamp is a
local durable confirmation, not the remote creation or use time. Legacy NULL
timestamps, erased accounts, pre-Weletic history and multiple accounts per
shopper remain unknown. The existing recorded-debit series remains separate
because a debit can precede uncertain or compensated issuance.

Local evidence: focused service/UI tests and an isolated MySQL transaction
covering a pre-range confirmation, same-month duplicates, repeat months,
legacy NULL, zero points, tenant/case isolation, redaction and exact date
boundaries. The test independently verifies no fixture tables remain. This
change adds no migration but reads the nullable field introduced with the
reward-issuance source index. Apply that schema before deploying the reader;
provider-scale query planning and installed merchant acceptance remain open.
