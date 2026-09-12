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

## September 9 addendum — reference preservation

Observation date: 2026-09-09, Asia/Tokyo. Reference store remains inspection-only.
The September 8 observations above remain valid at their stated evidence level;
this addendum records new observations without claiming executed parity. No
customer rows, generated reward codes, signed embedded URLs or copied assets are
retained. Current configured values are not necessarily Smile factory defaults.

Evidence labels: **observed** = visible control/state; **UI-described** = copy,
not executed behavior; **documentation-described** = linked first-party help;
**unknown** = not safely observed. Implementation and acceptance examples are
Weletic requirements, not assertions about untested Smile internals.

### R1 — Conditional reward policies (17:40–17:43 JST)

Sources: `/reward-programs/referrals/friend`, `/reward-programs/points`, and the
unsaved new amount-discount form opened from Ways to redeem.

- **Observed:** friend amount reward is JPY 500, minimum purchase JPY 2,000,
  entire order, one-time purchases; recipient-account restriction, shipping and
  product combination, prefix and elapsed-time expiry controls are unchecked.
  Order-discount combination is explicitly forbidden by the friend-reward copy.
- **Observed:** new amount-reward form initially offers fixed 500-point cost for
  JPY 5, or incremental redemption; entire order or specific collection; optional
  recipient binding and VIP restriction; no minimum or minimum purchase; prefix;
  order/shipping/product combinations; optional elapsed expiry; active/disabled
  status and default/custom icon. These are unsaved form defaults, not a reward
  created for the store. Returning to Rewards left the original two rewards only.
- **Observed:** purchase-type choices are one-time, subscription and both. Clean
  existing form has disabled Save buttons; new form has Create. No explicit
  Discard affordance was established on these screens, so no conditional value
  was changed. Hidden cadence numeric bounds, expiry units/defaults and VIP
  selection validation remain **unknown** under the approved persistence boundary.
- **Documentation-described:** [Smile subscription discounts](https://help.smile.io/en/articles/12258089-configure-loyalty-discounts-for-subscriptions)
  describes first charge, a fixed number of charges, or every charge. A finite
  payment allowance includes the first charge, belongs to one subscription
  contract, and unused allowance is forfeited when the discount is removed;
  it cannot be split across contracts or resumed later. Existing-contract use
  depends on the subscription provider's discount support. This is not live proof.
- **Weletic gap / acceptance:** reconcile immutable reward policy snapshots and
  native discount issuance with those terms. For a three-payment reward, test
  payments 1/2/3 versus 4, removal/reapplication, two distinct contracts, and
  retries of the same order. Do not equate a reward's recurring discount limit
  with earning-order classification. First-N earning/referral behavior remains
  an independently approved Weletic requirement. Resolve unknown validation from
  this first-party help and current Shopify schema, not an invented Smile default.

Points page also explicitly exposes expiry options 3 days, 7 days, 1/2/3/6
months, 1/2 years; the current inactive selection is one year. Purchase delay is
off with a displayed 30 days after paid. Expiry warning/last-chance are 30/3 days.
No activation, policy edit, creation, redemption or send was performed.

### R2 — Launcher, panel and shopper states (17:43–17:45 JST)

Sources: On-site content → Launcher / Panel. **Observed configuration:** launcher
copy is Rewards on both devices; circular shape; right placement; desktop side /
bottom spacing 20px, mobile 16px; primary background and white text; desktop
icon-with-text, mobile text-only; desktop-and-mobile visibility. Homepage hiding
is unchecked and no URL exclusion is configured. Custom stack order is unchecked;
its disabled input displays 2147483647 and `!important` is disabled. Shape menu
offers square, shaved, rounded and circular. Icon choices are bag, tag, crown,
star and present, plus upload. Switching desktop/mobile preview did not enable
Save; no configuration changed. Numeric bounds and exclusion matching semantics
beyond the visible "URLs that contain" wording remain unknown.

Panel banner minimum is 1080×600; brand icon 108×108. Home content has separate
visitor/member headers, account-creation title/description/sign-in/create-account
copy, and reorderable Points/Referrals/VIP. Description displays a 250-character
limit. Default opening view is Home, with earn/redeem/refer alternatives. This
configuration selector is distinct from the non-persisting current-view preview.
Current-view menu offers Home, Birthday entry, Referral program details and VIP
program details. Existing September 8 appearance observations cover color/shape
roles; no full asset or artwork is copied.

**Observed preview states, not authenticated shopper journeys:** visitor Home
offers join/sign-in, earning/redeeming entry points, friend/advocate offer summaries
and VIP thresholds. Member Home displays sample balance/tier, available-reward
count, earning/redeeming buttons, referral count/sharing, next-tier progress and
activity. Referral detail shows separate friend/advocate rewards and copy/share
controls. No sharing control was executed. Clicking the sample redeem-navigation
button did not change the preview; wallet, redemption confirmation, real referral
landing/claim errors and runtime authentication behavior remain unobserved.

**Weletic gap / acceptance:** basic branding currently supports one launcher
text/position/icon, colors, panel title/subtitle/hero and enablement. Embedded
appearance exposes only brand name/logo/accent rather than the complete loyalty
branding contract. Add separately reviewed device/visibility/content contracts,
not copied Smile assets. Test each layout at 375px/desktop, visibility exclusions,
guest/member content, section/deep-link navigation, keyboard focus and contrast.
Wallet/auth/retry acceptance must use Weletic's actual components, not this preview.

### R3 — All three nudges (17:45–17:48 JST)

Source: On-site content → Nudges and individual editors. **Observed:** inventory
contains account creation (first-time visitor), points spending (enough points at
cart), reward usage (available reward at cart). All three were disabled in the
September 8 capture; all remain disabled on reinspection. Editors
offer default/four preset/upload icons, title/description/button copy, restore
defaults, Save and separate Enable. No Enable/restore/save was used. Account copy
prompts joining/signing in; spending copy uses
`{{points_program.points_label_plural}}` and
`{{customer.points_balance_formatted}}`, with an available-rewards CTA. After a
delayed menu response, title offered Currency name and description offered Customer
points balance; no insertion occurred. Reward-usage copy prompts applying the
available reward, with a View reward CTA. Disabled editor preview
showed only the launcher, so dismissal/runtime behavior was not directly observed.

**Documentation-described:** [Smile nudge behavior](https://help.smile.io/en/articles/4036261-configure-nudges)
specifies one first-page signup impression per new browser visitor; another
browser/device/private session may see it again. Cart nudges require a logged-in
member and a cart page, not a cart slider. Reward usage wins when both cart nudges
qualify; an applied checkout discount suppresses it. Gift card, store credit and
variable rewards are excluded. Uploaded icons are square PNG/JPEG, minimum 80px.
Visual styling and placement inherit program appearance. These are documented
rules, not executed reference-store tests. Dismissal TTL, repeated cart impressions,
cross-tab coordination and the exact definition of "available" remain unknown.

**Weletic gap / acceptance:** no full editor/runtime set found. Implement an
explicit eligibility evaluator and a privacy-safe impression/dismissal policy
after choosing the unresolved TTL/storage semantics. Tests: first/new/repeat
visitor; guest cart; affordable/unaffordable balance; existing coupon; both nudges
eligible; expired/used reward; excluded stored-value/incremental types; cart page
versus drawer; disabled state; EN/JA/VI and keyboard dismiss/focus. This work is
deferred, not part of tonight's existing-core-flow fixes.

### R4 — Communications reconciliation (17:48–17:50 JST)

Source: `/settings/customer-notifications`. All ten entries and their on/off
states match September 8: points earned off; the other nine on. Preserve that
inventory rather than equating it with Weletic's nine policies. No test send,
activation, restore-default or Save operation was performed.

The existing subjects/variables above remain the reference. Reinspection adds:

| Journey                       | Visible trigger/timing and preview sections                                                                                                            | Weletic disposition                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Points warning                | 30 days before balance expiry; expiry date, keep-points prompt, next reward/progress, earning actions, reward/earn navigation, preferences/unsubscribe | Existing policy; connect immutable producer and existing expiry schedule                                                                                   |
| Points last chance            | Three days before balance expiry (September 8)                                                                                                         | Same schedule source; separate idempotent threshold                                                                                                        |
| Birthday                      | Birthday reward notification (September 8)                                                                                                             | Existing policy; birthday eligibility and approved timezone                                                                                                |
| Points earned                 | Reward-name subject, next reward and earning sections (September 8); disabled                                                                          | Existing policy; delivery not connected                                                                                                                    |
| Reward redeemed               | Reward-name/amount variables, code and terms (September 8)                                                                                             | Existing policy; ownership-safe confirmed-issuance event                                                                                                   |
| Referral completed            | Advocate confirmation after friend qualification (September 8)                                                                                         | Existing advocate policy; duplicate/refund handling                                                                                                        |
| Friend received referral      | Friend reward confirmation (September 8)                                                                                                               | Existing friend policy; claim/consent handling                                                                                                             |
| Referral shared through Smile | Member-initiated share; advocate/reward subject, optional personal message, offer-acceptance CTA; description variable menu offers reward name         | **Additional journey not in the nine-policy contract**; decide whether app-delivered invitations are required or native email sharing remains the boundary |
| VIP tier achieved             | Tier name, next tier and membership expiry (September 8)                                                                                               | Existing policy; define promotion/retention/downgrade semantics explicitly                                                                                 |
| Reward expiry                 | Three days before expiry; reward name/date, code, use-reward CTA and terms; preferences footer                                                         | Existing policy; validated reward-expiry schedule and usable-reward suppression                                                                            |

Warning, sharing and reward-expiry editors were reopened today. Shared controls
include subject, applicable title/description/button fields, banner minimum
1200×480, desktop/mobile preview, sent count, Save and independent activation/test
send controls. Reward-expiry form exposes no timing input in this screen. Email
appearance/logo and sender/reply-to controls are preserved in September 8 notes;
merchant identities are intentionally omitted. Sample preview substitutions are
not recipient data, delivered email proof, or a complete list of editable tokens.
Conditional sections not directly reopened remain September 8 evidence, not new
observations. Rendering/consent/suppression/lease/retry/privacy acceptance belongs
to backlog L10; copy must use Weletic branding and trusted recipient/CTA context.

### R5 — VIP and campaign semantics (17:50–17:53 JST)

Sources: `/reward-programs/vip`, Silver detail, Bonus campaigns/new.
**Observed:** VIP is active; current thresholds are 0/75,000/175,000 earned points.
Opening Tier settings exposes disabled points-earned/amount-spent alternatives,
lifetime/calendar-year alternatives, and a start-date range from account creation
through today. UI requires deactivation before edits; Cancel was used, without
deactivation. Calendar-year copy explicitly promises the rest of the qualifying
year plus the following full year. Lifetime copy promises permanent status.
Silver's milestone/name are disabled; icon minimum 90px; entry rewards and perks
are empty. Entry-reward copy still says once per customer. No configurable
additional grace-period control was observed.

**Documentation-described / conflict retained:** [VIP milestones](https://help.smile.io/en/articles/4036321-understand-vip-tier-milestones)
confirms calendar qualification and next-year retention; spend-based progress
uses paid order totals including tax/shipping after discounts. [VIP rewards and
perks](https://help.smile.io/en/articles/4036320-vip-rewards-and-perks) describes
repeat entry rewards after downgrade/re-promotion and rewards for skipped tiers,
which is more nuanced than this store's once-per-customer editor copy. Perks are
merchant-fulfilled display text. [VIP notification rules](https://help.smile.io/en/articles/4036329-vip-program-tier-rewards-and-customer-email-notifications)
contains conflicting prose/table for downgrade email behavior. These conflicts
are unresolved; do not silently change Weletic's immutable/once-only policy.
L04 must record an explicit approved decision before implementing different
re-promotion or notification semantics. Test year-end qualification/retention,
multi-tier jumps, refund downgrade, re-promotion, import placement and replay.

**Observed campaign draft:** default 2×; supported multiplier list unchanged;
start date/time initially absent, start-now unchecked, end-duration radios disabled
until a start is chosen. Name is merchant-only. Schedule remains disabled in this
empty form. UI says campaigns can be ended, running rules cannot be edited,
orders only, refunds/exchanges adjust awards and no promotional email is sent.
No campaign exists; returning to the list created none. Product/collection and
VIP targeting controls were not present in this draft.

**Documentation-described:** [campaign management](https://help.smile.io/en/articles/8802037-manage-a-bonus-points-campaign)
adds a 31-day maximum, non-overlapping campaigns, one active order-earning action,
and a once-per-customer automatic campaign prompt that cannot be edited/disabled.
That prompt is separate from the three merchant-configurable nudges. It was not
observed running here. L05/L08 must disposition this extra prompt explicitly;
Weletic's approved SKU/collection/VIP targeting and refund snapshots remain
intentional product requirements, not inferred Smile functionality.

**Intentional accounting divergence:** [Smile refund cancellation help](https://help.smile.io/en/articles/4036183-configure-points-cancellation-for-refunds)
describes dependence on the current enabled earning rule/rate. Weletic must keep
immutable original line allocations and bounded reversals; never reproduce
historical reinterpretation merely for competitor parity. L01/L05 tests must
prove refund correctness after rule/campaign edits or deactivation.

### R6 — Analytics inventory and definitions (17:53–17:56 JST)

Sources: `/analytics` and `/analytics/reports`. **Correction to the earlier
inventory:** there are **34 included reports plus two separately locked Finance
reports**, not 34 including the locked reports. Both pages state daily refresh;
the observed refresh age was 17 hours. This is not real-time data.

Included inventory, with stable reference IDs for backlog L11:

| ID  | Category              | Exact visible report name                     |
| --- | --------------------- | --------------------------------------------- |
| S01 | Data exports          | List of customers                             |
| S02 | Data exports          | List of customers by VIP tier                 |
| S03 | Data exports          | List of customers who can redeem              |
| S04 | Data exports          | List of customers with points expiring        |
| S05 | Data exports          | List of discounts created by Smile            |
| S06 | Data exports          | List of excluded products                     |
| S07 | Data exports          | List of orders                                |
| S08 | Data exports          | List of orders by VIP tier                    |
| S09 | Data exports          | List of orders placed by referred customers   |
| S10 | Data exports          | List of points redemptions                    |
| S11 | Data exports          | List of points transactions                   |
| S12 | Data exports          | List of referrals                             |
| S13 | Data exports          | List of Smile influenced orders               |
| S14 | Data exports          | List of top earning customers all-time        |
| S15 | Data exports          | List of VIP tier changes                      |
| S16 | Key metrics           | Order earning rate over time                  |
| S17 | Key metrics           | Redemption rate over time                     |
| S18 | Key metrics           | Reward usage rate over time                   |
| S19 | Key metrics           | Sales influenced by Smile over time           |
| S20 | Key metrics           | Smile benchmarks                              |
| S21 | Points                | First time vs repeat earners over time        |
| S22 | Points                | First time vs repeat redeemers over time      |
| S23 | Points                | Outstanding points over time                  |
| S24 | Points                | Points activity over time                     |
| S25 | Points                | Top ways to earn                              |
| S26 | Points                | Top ways to redeem                            |
| S27 | Points                | Total members over time                       |
| S28 | Referrals             | Referral conversion rate over time            |
| S29 | Referrals             | Referral traffic over time                    |
| S30 | Referrals             | Sales from referred customers over time       |
| S31 | Referrals             | Top referrers                                 |
| S32 | VIP                   | VIP tier behaviour over time                  |
| S33 | VIP                   | VIP tier changes over time                    |
| S34 | VIP                   | VIP tier members over time                    |
| S35 | Finance — Plus locked | Financial value of discounts issued over time |
| S36 | Finance — Plus locked | Financial value of outstanding points         |

**UI-described definitions exposed by clicking metric labels today** (not reverse
engineered from titles): loyalty-driven revenue counts sales using a Smile code,
including points/VIP/referrals. Estimated member CLV is AOV × annual purchase
frequency × three years; frequency divides member orders by ordering members.
Redemption rate divides redeemed points by earned points. Order earning rate
divides points-earning orders by all orders. Reward usage divides used rewards
by rewards redeemed with points. Membership rate divides ordering members by all
ordering customers. Referred-customer revenue includes subsequent orders; traffic
counts referral-link clicks; conversion divides completed referrals by clicks.
**Referral share rate divides referred-customer orders by all orders**, not link
shares. Total referred orders counts orders by referred customers. Refund, zero
denominator, identity deduplication and attribution-window details are not exposed
by these descriptions; do not invent them. Weletic must label its own definitions.

Insights windows: growth last 12 months; performance, points and referrals last
30 days; VIP segments describe members ordering in the last 12 months. Segment
columns are customer count, annual spend, annual purchase frequency and AOV.
No customer counts, actual financial values or rows are retained here.

Additional report controls observed so far: S02 VIP Tier; S03 membership date and
points balance; S04 expiry date (empty result, no columns); S06 date. S05 filters
channel, issued date (previous 30 days), used date, usage status, expiry, state and
source. Its usage-status menu offers untracked/unused/used; no filter was applied.
Visible S05 columns: first/last name, email, channel, discount code, reward name,
source type, reward type, discount value, financial value, usage status, issued at.
These are schema labels only, not approval to expose shopper data in Weletic's
aggregate analytics. Horizontally virtualized or empty report columns must not be
assumed complete from an initial viewport. Existing September 8 schemas cover
S01/S07/S10/S11/S15; S12 remained empty. No export was downloaded.

#### Report schema supplement (17:56–18:04 JST)

All included report areas have now been inspected today or dispositioned through
the existing September 8 observation. Only labels/controls are retained below.
"Visible columns" means rendered header evidence, **not a certified full export
schema**; wide grids can virtualize later columns. No filters were applied,
downloads initiated or customer rows retained. Date-range inclusion/timezone and
each metric's refund/deduplication details remain unknown unless stated above.

| Reports | Observed filters / initial window                                                      | Visible columns or explicit unknown                                                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01     | September 8 membership date, balance, can-redeem, membership status                    | Customer schema preserved above; full export verification deferred                                                                                                                    |
| S02     | VIP Tier                                                                               | Customer ID, first/last name, email, VIP tier, delta to next tier, balance, referral URL, membership, became member, first/last earned; later virtualized columns unknown             |
| S03     | Became Member At, Points Balance                                                       | No results; schema unknown                                                                                                                                                            |
| S04     | Points expire at                                                                       | No results; schema and exact selected interval not retained                                                                                                                           |
| S05     | Channel, issued/used/expiry date, usage status, state, source; issued previous 30 days | Visible schema above; later virtualized columns unknown                                                                                                                               |
| S06     | Date, no displayed initial restriction                                                 | No results; schema unknown                                                                                                                                                            |
| S07     | September 8 date/earned/Smile-code controls; previous 30 days                          | Order schema above                                                                                                                                                                    |
| S08     | Date previous 30 days; VIP Tier name                                                   | First/last name, email, order number, VIP tier, grand total, rewardable total, points earned, placed at                                                                               |
| S09     | Date Range previous 30 days                                                            | No results; schema unknown                                                                                                                                                            |
| S10     | September 8 date/channel; previous 30 days                                             | Redemption schema above                                                                                                                                                               |
| S11     | September 8 date/type/minimum/maximum points; previous 30 days                         | Transaction schema above                                                                                                                                                              |
| S12     | September 8 date previous 30 days                                                      | Empty; schema unknown                                                                                                                                                                 |
| S13     | Date Range previous 30 days                                                            | No results; schema unknown                                                                                                                                                            |
| S14     | Minimum points earned initially 1                                                      | No results; schema unknown                                                                                                                                                            |
| S15     | September 8 date/change type/new tier; previous 30 days                                | Tier-change schema above                                                                                                                                                              |
| S16     | Date Range previous 12 months; Time Interval control                                   | Date, orders, orders where customers earned points, order earning rate                                                                                                                |
| S17     | Date Range previous 12 months; Month                                                   | Date, points earned, points redeemed, redemption rate                                                                                                                                 |
| S18     | Date Range previous 12 months; Month; Type                                             | Date, source type, total discounts used, total discounts created, reward usage rate                                                                                                   |
| S19     | Date Range previous 12 months; Month                                                   | Date, orders/sales influenced, orders/sales with redemptions, orders/sales from referrals, orders/sales with VIP rewards, member orders influenced; later virtualized columns unknown |
| S20     | Tabs for redemption/reward usage/order earning; no editable filter observed            | Peer-comparison presentation, no export column schema observed; redemption description uses monthly points spent/earned                                                               |
| S21     | Date Range previous 12 months; Month                                                   | Date, customer type, total earners                                                                                                                                                    |
| S22     | Date Range previous 12 months; Month                                                   | Date, customer type, total redeemers                                                                                                                                                  |
| S23     | No date/interval control observed                                                      | Date, net points change, cumulative outstanding points; implied history/window not inferred                                                                                           |
| S24     | Date Range previous 12 months; Month                                                   | Date, points earned/redeemed/refunded/expired, manual adjustment, net points change                                                                                                   |
| S25     | Date Range previous 30 days                                                            | Comment, Total; exact meaning of Total not inferred                                                                                                                                   |
| S26     | Date Range previous 30 days                                                            | Reward name, Total; exact meaning of Total not inferred                                                                                                                               |
| S27     | Date Range previous 30 days; Day                                                       | Date, new members added, cumulative members                                                                                                                                           |
| S28–S30 | Date Range previous 12 months; Month                                                   | All three expose date start, orders/sales from referrals, total referral traffic, referrals started/completed, referral conversion rate                                               |
| S31     | Referral Completed At previous 90 days                                                 | No results; schema unknown                                                                                                                                                            |
| S32     | Date Range previous 12 months; Month                                                   | No results in both displayed sections; schema unknown                                                                                                                                 |
| S33     | Date Range previous 12 months; Month                                                   | Date, VIP tier, added/promoted/demoted/removed from tier                                                                                                                              |
| S34     | Previous 12 months or this month; Month                                                | Date, VIP tier, total members                                                                                                                                                         |
| S35–S36 | Plus locked                                                                            | Controls, columns, valuation/rounding and formulas unobserved; no upgrade attempted                                                                                                   |

S18's report includes source type and discounts created, while its Insights label
describes rewards redeemed with points. Do not assume those denominators/scopes
are identical. Similarly, three referral charts sharing table columns does not
prove unique-click rules or a sequential funnel. Preserve exact Weletic definitions
and reconcile independent SQL before claiming parity.

Follow-up without paid access: use the relevant first-party Smile help linked
from each feature, current Shopify native schemas, and Weletic's approved financial
contracts to define missing field/metric semantics. If a source does not resolve
an empty/virtualized/locked report schema, L11 must explicitly choose a Weletic
report contract or defer that comparison. No tomorrow task is allowed to silently
invent Smile behavior or require a new paid subscription to begin.

### First-party follow-up sources (retrieved September 9)

These fill implementation context without claiming the hidden controls were
executed in the reference store:

- [Earning limits](https://help.smile.io/en/articles/4036269-configure-points-earning-limits):
  documentation describes a per-action count/window beginning with the first
  qualifying earn, plus include/exclude VIP-tier eligibility. Exact selectable
  windows/bounds were not observed. L01/L03 must test counter windows and VIP
  eligibility against an explicitly approved Weletic policy.
- [Reward expiry](https://help.smile.io/en/articles/4036282-configure-reward-expiry):
  documentation lists 3/7 days, 1/2/3/6 months and one year; default no expiry;
  prospective newly issued codes only; no gift-card expiry. It describes expiry
  visibility before redemption, after issuance and in the account hub, and says
  configuring expiry enables a reminder. Weletic must not copy implicit email
  activation: L02/L10 retain explicit consent/availability controls and immutable
  issuance terms. Actual hidden default/validation remains unobserved.
- [Email variables](https://help.smile.io/en/articles/4036262-use-variables-to-insert-relevant-information-into-customer-emails):
  documentation distinguishes preview placeholders from real values and notes
  points-earned notices exclude signup/social follows. Reward context includes
  reward name/code/instructions/terms/action, formatted points spent, customer
  balance/tier/progress/referral information. This is not permission to expose
  customer IDs/email or trust merchant-provided recipient/CTA/code fields. L10
  must explicitly map each allowed template variable to trusted event context.
- [Referral abuse](https://help.smile.io/en/articles/4036291-preventing-referral-fraud):
  documentation describes blocking at claim or qualifying purchase, risk reasons
  such as similar identity, non-first/self order and high same-IP volume; the
  stated IP example is ten referrals within a week. A blocked claim shows an error;
  blocked qualification withholds advocate fulfillment. Review can cancel/unblock,
  potentially issuing rewards/sending email. These controls were not executed;
  do not adopt heuristic identity matching or IP retention without policy review.
- [Referral cancellation](https://help.smile.io/en/articles/4036297-cancel-referral):
  documentation distinguishes pending claimed-but-not-ordered from completed.
  Cancellation prevents advocate fulfillment, voids eligible codes and can adjust
  awarded points; it is irreversible. Refund/removal/deletion can cancel pending
  or associated referrals as described there. L06 must separately prove used-value
  containment, exact ledger reversal, permissions and privacy; no cancellation
  was performed in Smile.

### Explicit unknowns and implementation handoff

| Unknown                                                                                                   | Evidence boundary                                                        | Follow-up / task                                                                                 |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Hidden subscription numeric bounds, earning windows and VIP selector validation                           | No established Discard path on those reward forms; values left unchanged | Subscription/earning help above, current native schema and approved contract; L01/L03            |
| Actual guest/member wallet, redemption and referral claim failures in Smile                               | Editor previews only; no customer transaction/claim                      | Preserve state requirements in L02/L06; test Weletic components and later approved live fixtures |
| Nudge dismissal TTL, repeated impressions, cross-tab/device storage                                       | Disabled runtime; documentation does not specify exact dismissal policy  | Explicit product decision before L08 implementation; no guessed Smile value                      |
| Extra automatic campaign nudge                                                                            | First-party description only, no running campaign                        | L05/L08 inclusion/disablement decision; no campaign created to inspect it                        |
| VIP repeat-entry, skipped tiers, downgrade notices                                                        | UI/help conflicts preserved in R5                                        | L04 explicit policy decision; preserve current approved invariants meanwhile                     |
| Complete per-journey token allowlist / conditional email sections                                         | Existing subjects and selected previews, not all hidden variable menus   | Linked email-variable source and L10 trusted-context mapping/fixture previews                    |
| Full empty/virtualized report export schemas, exact filter timezone and metric refund/deduplication rules | R6 individually identifies partial/empty observations                    | L11 explicit report contracts and independent SQL; do not infer formulas                         |
| Finance Plus reports                                                                                      | Visible locked entries only                                              | Keep S35/S36 unobserved; use approved Weletic accounting, not a simulated Smile export           |
| Proprietary peer benchmark population                                                                     | No reproducible company-store source                                     | L11 choose company history/targets or explicitly omit peer comparisons                           |

All six requested reference areas and the 34+2 report inventory now have a
documented disposition. This is **reference-preservation coverage with explicit
unknowns**, not exhaustive executed Smile behavior or completed Weletic parity.
