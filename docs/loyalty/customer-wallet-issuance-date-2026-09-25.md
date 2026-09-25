# Customer reward wallet issuance date

The authenticated customer wallet previously returned a redemption's
`createdAt` as `issuedAt`. That date marks the local reservation, which can
precede a remote artifact or end in compensation. The candidate response now
uses `issuanceConfirmedAt` and returns `null` when the confirmation is unknown,
including historical issued rows. The customer-account card already displays
the localized status without an invented date when `issuedAt` is absent; its
public type now permits `null`.

The storefront cart nudge requires a confirmed issuance date before suggesting
an available coupon. Historical issued rewards with an unknown date remain
visible and usable in the authenticated wallet, but are not suggested by that
nudge. This preserves the existing evidence gate instead of substituting a
reservation timestamp for issuance.

This follows the merged [issuance confirmation prerequisite](reward-issuance-confirmation-2026-09-25.md)
and adds no migration. The release target still needs that prerequisite's
schema-first application before this reader can run. It does not establish
remote creation time or complete the reward-usage report. Authenticated
installed acceptance in EN/JA/VI remains open.
