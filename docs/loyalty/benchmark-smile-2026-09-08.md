# Smile paid-trial reference — 2026-09-08

Read-only Chrome observations on `n0pvef-cs`. No values changed, saves,
activation, emails, subscription changes, or transactions. Observed controls
are not executed behavior or proof of plan entitlement. Home banner showed
"Free trial ends in 1 day"; not treated as an exact billing deadline. No
screenshots were retained; this normalized note is the durable reference.

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
payment settings were deliberately not inspected: revealing them would require
changing the selected form value, which was outside this read-only capture. No
test redemption performed.

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
after-purchase points.

The launcher editor separates desktop/mobile copy, position and visibility. It
offers default or uploaded icons; shape; left/right position; side/bottom spacing;
primary/background and font colors; desktop icon/text ordering; mobile text or
icon layout; desktop-and-mobile, desktop-only or hidden visibility; homepage and
URL-substring exclusions; and optional `z-index` plus `!important`. Desktop and
mobile previews are separate.

The panel editor exposes minimum-size banner and brand-icon uploads, visitor and
member headers, account-creation copy and calls to action, reorderable Points /
Referrals / VIP sections, and a default opening view (home, earn, redeem or
refer). It publishes section deep links such as `#smile-home`. Appearance offers
light/dark styles, branded primary/secondary colors, separate banner/header/
button/link/icon roles, container/card/button/input shapes, six wallpaper
choices, and optional Smile attribution. The UI states these appearance choices
also flow into nudges and email.

Three nudge editors are included and disabled in the reference store: first-time
visitor account creation, points spending when a shopper can redeem at cart, and
available-reward usage at cart. Each supports a default/preset/uploaded image,
editable title/description/button, default restoration and preview. Observed
defaults use `{{points_program.points_label_plural}}` and
`{{customer.points_balance_formatted}}` for the points-spending nudge; the other
defaults prompt sign-up/login or adding the available reward to cart. No theme,
customer-account editor, nudge enablement, activation or save was performed.

## Communications

Source: `/apps/smile-io/settings/customer-notifications`.
Listed journeys: expiry warning and last chance, birthday reward, points earned,
reward redeemed, referral completed, friend received referral, referral shared
through Smile, VIP tier achieved, reward expiry reminder. Separate appearance
customization. General settings expose sender name and reply-to identity.
Recipient addresses and merchant contact values are intentionally omitted here.
No test email sent and no notification toggled.

The reference statuses were: all listed journeys on except Points earned, which
was off. Expiry warning and last chance are configured for 30 and three days
before balance expiry respectively; reward expiry reminder is three days before
reward expiry. Every message editor includes a minimum 1200 x 480 banner,
desktop/mobile preview, test-email control, activation toggle and save control.
Email appearance separately exposes button/text colors derived from branding and
a minimum 400 x 144 logo.

Observed subjects and variables were:

- Points expiry warning and last chance:
  `Your {{reward_program.points_label_plural}} from {{store_name}} expire on {{customer.points_balance_expires_at_formatted}}`.
- Birthday reward: `Happy birthday!`.
- Points earned: `You've earned {{reward_fulfillment.name}}!`; reward-name variable.
- Reward redeemed: `Your {{reward_fulfillment.name}} confirmation`; reward name
  and currency-formatted redemption amount variables.
- Referral completed: `Your friend used your referral!`; reward-name variable.
- Friend received referral: `Your {{reward_fulfillment.name}} reward confirmation`;
  reward-name variable.
- Referral shared through Smile:
  `{{ advocate_customer.full_name }} gave you {{ friend_reward.name }} to use on your first order`;
  advocate name, friend reward and custom-message preview content.
- VIP tier achieved: `You've achieved {{ customer.vip_tier.name }}!`; customer
  tier-name variable plus next-tier and membership-expiry preview content.
- Reward expiry reminder: `Your reward is expiring soon!`.

Default previews combine the event message with contextual next-reward, earning,
redemption-code/terms, referral or tier-benefit sections as applicable, plus
preference management. No preview customer values were retained.

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

Read-only report previews exposed these filters and export columns without a
download:

- Customers — filters: became-member date, points balance, enough-points-to-redeem
  flag and membership status. Columns: Smile customer ID, first name, last name,
  email, points balance, referral URL, membership status, date of birth, became
  member at, first/last points earned at, first/last points redeemed at and last
  order placed at.
- Points transactions — filters: date range (default previous 30 days), change
  type, minimum points and maximum points. Columns: Smile customer ID, first name,
  last name, email, comment, points change, new balance, internal note, type and
  date.
- Points redemptions — filters: date range (default previous 30 days) and channel.
  Columns: Smile customer ID, first name, last name, email, channel, date, points
  redeemed, reward name and code.
- Orders — filters: date (default previous 30 days), points earned and Smile-code
  presence. Columns: email, placed at, order number, payment status, POS flag,
  discount codes, Smile-code flag, grand total, rewardable total, points earned
  and referred-customer flag.
- VIP tier changes — filters: date range (default previous 30 days), change type
  and new tier. Columns: Smile customer ID, first name, last name, email, type,
  new tier, old tier and changed at.
- Referrals — date range (default previous 30 days). The empty reference report
  displayed no column schema, so none is inferred.

No report filter was applied, no export downloaded and no plan upgrade opened.
