# Smile paid-trial reference — 2026-09-08

Read-only Chrome observations on `n0pvef-cs`. No values changed, saves,
activation, emails, subscription changes, or transactions. Observed controls
are not executed behavior or proof of plan entitlement. Home banner showed
"Free trial ends in 2 days"; not treated as an exact billing deadline.

## Points

Source: `/apps/smile-io/reward-programs/points` under the reference Shopify admin.
Points currency singular/plural branding, purchase points delay (off; displayed
30 days after paid), expiration period options from days to two years, warning
threshold (displayed 30 days) and last-chance threshold (displayed three days).
Expiry is disabled. Existing redemption lists include free product and rational
order discount, displayed 100 points for JPY 1.

Purchase earning editor: incremental or fixed points; per-customer action limit;
VIP restriction; product exclusion management; status and custom icon. Did not
change toggles to inspect conditional inputs.

The action selector lists order, birthday, signup; Facebook like/share, Instagram
follow, X share/follow, TikTok follow, and link click. Review earning is presented
as a Judge.me connection prompt. No integration connected and no action saved.
The menu alone does not prove third-party social-action verification.

Birthday draft shows fixed points, optional VIP restriction, status/icon, and a
summary saying birthday must be entered at least 30 days in advance. Opening the
new form created unsaved client state; explicitly discarded it. Returned points
list still contains only the original order rule. No birthday action created.

## Referrals

Source: `/apps/smile-io/reward-programs/referrals`.
Separate advocate and friend offers; UI says advocate reward follows friend's
first order. Sharing via Facebook, X and email; editable link-preview metadata;
configurable landing URL (defaults to homepage).

Friend coupon editor: `/apps/smile-io/reward-programs/referrals/friend`.
Purchase type menu explicitly lists one-time, subscription and both. Entire-order
or specific-collection applicability; recipient-account binding option; minimum
purchase requirement; code prefix; shipping/product discount combination controls;
copy excludes combination with order discounts; optional elapsed-time reward
expiry; custom icon. No subscription option selected, so conditional recurring
payment settings are not yet observed here. No test redemption performed.

Incremental order-discount reward editor separately shows points step, reward
value, minimum/maximum redemption points, purchase-type menu, collection scope,
recipient binding, VIP eligibility, minimum order value, prefix and expiry.
Unlike friend referral discounts, this editor offers order-discount combination
alongside shipping/product combinations. No values changed. This distinction
must remain explicit rather than sharing one unqualified combinations policy.

## VIP

Source: `/apps/smile-io/reward-programs/vip`.
Tier list with thresholds and customer drill-down; tier settings show program
start date, qualification by earned points, and one-calendar-year period in
this configuration. Current tier-name Shopify projection is offered separately
and is off. No projection activated. A fresh tab recovered inspection after the
first tab timed out.

Silver detail: milestone and name edits disabled while program active; custom
icon; entry rewards described as once per customer; free-text perks. Ongoing
discounts refer merchants to a third-party app (Regios), not automatic native
fulfillment demonstrated here. Entry reward selector lists amount, percentage,
shipping, free product, gift card, store credit and points. Selector closed
without choosing or adding a reward.

## Bonus campaigns

Source: `/apps/smile-io/reward-programs/points-bonuses/new`.
Opened an empty form and left without scheduling. Name, multiplier (1.5, 2, 2.5,
3 through 10), start date/time or start-now, duration presets 1/2/3 days or custom.
UI says local timezone, running campaigns cannot be edited, bonus applies only
to orders, refunds/exchanges adjust points, and Smile sends no promotional event
emails. Those are UI claims, not executed refund or send proof. No SKU/collection
targeting inputs observed in this form; Weletic's approved targeting remains an
explicit product requirement, not inferred Smile parity.

## Storefront surfaces

Source: `/apps/smile-io/on-site`.
Launcher, panel, nudges; dedicated landing page; loyalty hub in modern Shopify
customer accounts; product-page earning points; customer-account points banner;
after-purchase points. No theme/account editor or activation opened.

## Communications

Source: `/apps/smile-io/settings/customer-notifications`.
Listed journeys: expiry warning and last chance, birthday reward, points earned,
reward redeemed, referral completed, friend received referral, referral shared
through Smile, VIP tier achieved, reward expiry reminder. Separate appearance
customization. General settings expose sender name and reply-to identity.
Recipient addresses and merchant contact values are intentionally omitted here.
No test email sent and no notification toggled.

Points-earned editor: subject/title/description, variables, banner, desktop/mobile
preview, sent count, test-send and activation controls. Preview includes next
reward, more earning actions and preference management. No values changed and no
send clicked; Weletic's own consent/service-message policy still governs content.

## Analytics

Source: `/apps/smile-io/analytics`.
Daily-updated insights grouped into business growth (loyalty-driven revenue,
member CLV, annual purchase frequency), performance benchmarks (redemption,
order earning, reward usage, membership), customer segments, points activity,
referral revenue/traffic/conversion/sharing/orders, and VIP segments. Displayed
time windows vary between 30 days and 12 months. No raw customer financial values
copied here; metric formulas and causal attribution were not validated.

Report inventory (`/analytics/reports`) lists 34 reports across exports, key
metrics, points, referrals and VIP. Exports include customer/tier/redeemable/
expiring groups, discounts, excluded products, orders and referral orders,
redemptions, points transactions, referrals, influenced orders and tier changes.
Time-series include earning/redemption/usage rates, balances, activity, member
growth, first/repeat earners/redeemers, top actions/referrers and VIP behavior.
The two finance reports (issued-discount value and outstanding-points value)
are visibly Plus-gated even in this trial. Do not claim this trial exposes all
Smile functionality or infer financial formulas from those locked titles.
No report export downloaded and no plan upgrade opened.
