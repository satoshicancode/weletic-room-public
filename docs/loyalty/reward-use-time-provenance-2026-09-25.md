# Reward use-time provenance

Status: implementation candidate. No shared schema or installed acceptance is
claimed.

The paid-order webhook currently records `usedAt` from Shopify's order
`created_at` when parseable, but falls back to the local observation time when
that field is absent or invalid. Remote voucher cleanup also records local
observation time. Those timestamps must not all be interpreted as event-time
discount use in S18.

This candidate adds nullable `usedAtBasis` to reward redemptions and append-only
shopper coupon-use rows. New paid-order settlements require an offset-bearing
ISO timestamp before treating `created_at` as event evidence and distinguish
`shopify_order_created_at` from `webhook_observed_at`; remote cleanup records
`remote_cleanup_observed_at`. Older rows remain `NULL` and are not backfilled
from `usedAt` or reservation time. Shopper privacy export includes the basis.
The owner row export and time-series report remain unchanged, so S18 is still
unavailable.

Apply the [additive SQL](../../infra/shopify-development/migrations/20260925_loyalty_redemption_use_time_basis.sql)
to the exact release target **before** deploying these writers or the privacy
reader. Check that the shopper coupon-use table already exists; a merged SQL
file or disposable rehearsal does not prove target application. Older workers
may ignore the columns during rollback, but retaining them is required so new
export phases and records remain readable after forward recovery.
