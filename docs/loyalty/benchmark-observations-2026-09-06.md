# Competitor reference checkpoint — 2026-09-06

Read-only browser inspection on `n0pvef-cs` (Shopify admin display name: Yamax),
2026-09-06, Asia/Tokyo. This is a partial configuration/UI checkpoint for package
1 of the [unified acceptance matrix](unified-acceptance-matrix.md), not a full
competitor audit or proof that the configured behavior executed correctly.
Neither an admin handle nor a display name establishes canonical backend shop
identity. No observations below belong to the `yamaxdev` acceptance environment.

No setting was edited or saved, reward issued, email sent, review imported,
integration connected, subscription changed or transaction performed. The
existing Judge.me tab was restored to its original settings URL; the temporary
Smile tab was closed. Customer records, tokens and full browser exports were not
copied into this document.

## Access and time-sensitive context

- The [Smile home panel](https://admin.shopify.com/store/n0pvef-cs/apps/smile-io)
  reported a trial with three days remaining. This is the displayed countdown,
  not a verified billing timestamp or authorization to extend/cancel it.
- The [Judge.me plan panel](https://admin.shopify.com/store/n0pvef-cs/apps/judgeme/settings/plan)
  identified the current plan as Awesome. Feature badges alone were not used to
  infer subscription status. Preserve the reference subscription.
- `yamaxdev`'s free competitor installations must not be substituted for this
  paid-feature reference. No plan change on either store follows from this audit.

## Observations and implementation consequences

The values are the benchmark's saved configuration, **not vendor defaults**.
The approved Weletic policies remain authoritative when they differ.

| Reference surface                                                                                                           | Observed configuration or control                                                                                                                                                                                 | Consequence for the approved Weletic implementation                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Smile points](https://admin.shopify.com/store/n0pvef-cs/apps/smile-io/reward-programs/points)                              | Purchase earning displays five points per yen. An order-discount reward displays 100 points per yen; a free-product reward is also present.                                                                       | Keep earning and redemption valuations distinct. The `1/100` JPY liability test is material; do not infer liability value from earning rate or silently configure Weletic from this store.                                                                          |
| [Smile points](https://admin.shopify.com/store/n0pvef-cs/apps/smile-io/reward-programs/points)                              | Order-point delay and expiry are off. Inactive controls display a 30-day paid-order delay, expiry choices from three days to two years, and 30-day/three-day warning thresholds.                                  | Test enabling/revisioning policies and warning scheduling separately from displaying controls. Disabled saved values do not prove delayed awards or expiration execution.                                                                                           |
| [Smile referrals](https://admin.shopify.com/store/n0pvef-cs/apps/smile-io/reward-programs/referrals)                        | Referral program is active; advocate and friend rewards each display a ¥500 coupon. Sharing options, link-preview metadata and a landing-page URL control are present.                                            | Finish the single shopper-referral journey, branded metadata, friend claim, first-order qualification and refund proof. Do not add another referral program for reviews.                                                                                            |
| [Smile VIP](https://admin.shopify.com/store/n0pvef-cs/apps/smile-io/reward-programs/vip)                                    | Active tiers use earned-points thresholds of 0, 75,000 and 175,000, with a calendar-year achievement window. VIP metafield synchronization is off.                                                                | Preserve qualification-mode/timeframe configuration and distinguish visible tier settings from qualification, downgrade, entry-award and Shopify-sync proof.                                                                                                        |
| [Judge.me scheduling](https://admin.shopify.com/store/n0pvef-cs/apps/judgeme/settings/review_collection/schedule_reminders) | Domestic/international requests display fulfillment +14 days. Domestic requests have one reminder; international requests have none.                                                                              | Implement separate domestic/international schedules and saved-policy preservation. New Weletic configurations retain the approved +7-day default, not these observed values.                                                                                        |
| [Judge.me scheduling](https://admin.shopify.com/store/n0pvef-cs/apps/judgeme/settings/review_collection/schedule_reminders) | Multi-product requests display three products, most expensive first, sent separately three days apart. Product overrides, delivery-time and repeat-variant controls are visible; customer frequency is unlimited. | Keep the approved consolidated order email, at most three links and one solicitation per shopper per seven days. Observe useful controls without cloning the competitor's current frequency or separate-message policy.                                             |
| [Judge.me scheduling](https://admin.shopify.com/store/n0pvef-cs/apps/judgeme/settings/review_collection/schedule_reminders) | The panel offers store-review fallbacks for unavailable/missing products and blocklist management. Sending to Shopify marketing opt-outs is checked.                                                              | Preserve separate product/store subjects and suppression. This checkbox does not override Weletic's affirmative marketing consent, requested-service allowlist or unsubscribe rules.                                                                                |
| [Judge.me coupons](https://admin.shopify.com/store/n0pvef-cs/apps/judgeme/settings/rewards/coupons)                         | Coupons are off. The panel offers generated/static/dynamic coupon modes plus a Smile review-points integration.                                                                                                   | Use the shared fulfillment/ledger and points-or-coupon policy. Do not implement a second coupon generator, enable the integration or award both incentives.                                                                                                         |
| [Judge.me coupons](https://admin.shopify.com/store/n0pvef-cs/apps/judgeme/settings/rewards/coupons)                         | Inactive coupon settings show a verified-buyer restriction, one coupon per order, reviewer-only eligibility, no combinations and 30-day validity. A single 10% discount applies across review types.              | Implement the durable per-order claim, explicit validity/stacking and actual recipient binding. These UI settings do not prove Shopify redemption enforcement or fraud reversal; Weletic's first-qualified-review and publication-independent policy still governs. |

## Additional review and communication surfaces

These observations extend the same read-only checkpoint. Editor sample reviews,
media and custom-question responses are demonstration content, not evidence of
real submissions, uploads or successful delivery on this store.

### Moderation and submission integrity

The [moderation panel](https://admin.shopify.com/store/n0pvef-cs/apps/judgeme/settings/reviews/moderation)
has automatic publication and spam filtering enabled, PII masking selected,
profanity filtering disabled and API submissions allowed. Its criteria dialog
currently accepts every rating, sentiment, verification state and media state.
Alternative controls can restrict minimum rating, sentiment, verification and
media; the dialog was inspected and closed without saving. This is not evidence
that the benchmark currently suppresses criticism. Weletic must not copy
rating/sentiment suppression: use the approved deterministic abuse checks,
audited moderation and publication-independent incentives. AI remains deferred.

The [collection-flow panel](https://admin.shopify.com/store/n0pvef-cs/apps/judgeme/settings/review_collection/collection_flow)
selects email confirmation after submission and permits everyone to use the
widget's submission button. The widget uses an in-store popup; email/QR/link
entry uses an external form. The panel describes order matching for purchase
verification and distinguishes imports, but no verification journey was run.
Keep email verification separate from purchase evidence, test token replay,
and do not add another competing Weletic popup.

### Form configuration and presentation

The [review-form editor](https://admin.shopify.com/store/n0pvef-cs/apps/judgeme/settings/reviews/widgets/write-a-review)
shows star-only submission and the title prompt disabled, with images and videos
enabled. A custom-question control and flow, styling and text sections are
present. No media was uploaded or form submitted. These controls inform field
validation and presentation; they do not prove processing limits or establish
new approved Weletic defaults.

The [custom-forms panel](https://admin.shopify.com/store/n0pvef-cs/apps/judgeme/settings/review_collection/custom_forms)
has no templates and offers template creation. Its explanatory copy mentions
attributes and NPS. No template was created or field-type inventory verified;
native versioned question definitions still require implementation and tests.

The [widget catalog](https://admin.shopify.com/store/n0pvef-cs/apps/judgeme/settings/reviews/widgets)
marks the review and submission widgets installed and offers stars, multiple
carousels, grid, snippets, counters, floating/popup, customer-account and Q&A
surfaces. It also lists AI, Instagram and provider-badge features. Nothing was
installed. Retain the approved reusable layouts, contextual reviews and one
customer hub; do not clone every catalog entry or expand deferred integrations.

The [Q&A editor](https://admin.shopify.com/store/n0pvef-cs/apps/judgeme/settings/reviews/widgets/questions-and-answers?jump_to=install)
has its question-submission checkbox disabled and describes a question button
and tab, with placement/text controls and a merchant-list link. No question,
answer or notification was created. Separate native Q&A moderation and answer
notifications remain unproved; Q&A must not automatically earn review rewards.

The [product-groups panel](https://admin.shopify.com/store/n0pvef-cs/apps/judgeme/settings/reviews/product_groups)
offers manual static groups and product-tag-synchronized dynamic groups; no
existing group was displayed or created. Implement the approved explicit groups,
source-product labels, distinct direct/grouped counts and projection invalidation.
The menu does not establish native grouping or cross-store sharing support.

### Languages and message categories

The [language panel](https://admin.shopify.com/store/n0pvef-cs/apps/judgeme/settings/multi_language)
uses English for the admin and US English for widgets/emails. Japanese appears
in both language selectors; Vietnamese appears in the widget/email selector,
not the inspected admin list. Multilingual widgets/emails, customer-language
priority and automatic review translation are disabled. The panel reports no
additional published Shopify languages, which was not independently checked.
Weletic's English/Japanese/Vietnamese interfaces and manual review translations
remain approved; this panel does not prove manual translation or merchant timezone.

The [email-template panel](https://admin.shopify.com/store/n0pvef-cs/apps/judgeme/settings/review_collection/emails)
shows request and store-review fallback templates enabled, alongside confirmation,
merchant-reply and Q&A notifications. Media reminders, coupon/referral messages
and their reminders are disabled. Sender and styling controls are present; no
editor values were changed or test messages sent. Adapt the shared shopper editor,
transport and delivery reporting for the approved journeys. Template visibility
does not establish consent enforcement, delivery, scheduling or retry correctness.

## Remaining comparison and acceptance work

This checkpoint does not certify the full native feature inventory. Remaining
reference gaps include actual open/store submission flows, reviewer edits,
custom-question definitions, media/video constraints, manual translation,
imports, advanced campaigns and detailed message policies. Observed moderation,
Q&A, grouping and template controls are not executed acceptance journeys.
Do not expand scope to
external syndication, AI, Klaviyo, POS or public billing because a menu offers it.

The implementation gaps in the acceptance matrix remain open. In particular,
the existing native review service still uses publication-coupled, per-review
awards; a competitor coupon checkbox does not repair that contract. Prioritize
the revisioned shared incentive claim and communication policy implementation,
then prove the required journeys on `yamaxdev` with approved controlled fixtures.
