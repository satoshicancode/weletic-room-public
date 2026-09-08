# Shopify Discount Provider UI — Design QA

## Evidence

- User reference: `/var/folders/_r/3_x8z56x6h34wckfthzkvmz00000gn/T/TemporaryItems/NSIRD_screencaptureui_drFKs1/Screenshot 2026-08-23 at 16.49.52.png`
- Source capture: `/Users/hironguyen/.codex/visualizations/2026/08/23/discount-provider-audit/01-current-discount-provider.png`
- Implementation capture: `/Users/hironguyen/.codex/visualizations/2026/08/23/discount-provider-audit/03-discount-provider-implementation.png`
- Expanded-recipient capture: `/Users/hironguyen/.codex/visualizations/2026/08/23/discount-provider-audit/04-discount-provider-recipients.png`
- Same-state comparison: `/Users/hironguyen/.codex/visualizations/2026/08/23/discount-provider-audit/05-before-after-comparison.png`
- Polish source, campaign editing: `/Users/hironguyen/.codex/visualizations/2026/08/23/discount-provider-review/02-campaign-editing.png`
- Polish implementation, campaign editing: `/Users/hironguyen/.codex/visualizations/2026/08/23/discount-provider-review/05-campaign-polish-implemented.png`
- Polish source, partner recipients: `/Users/hironguyen/.codex/visualizations/2026/08/23/discount-provider-review/03-partner-recipients.png`
- Polish implementation, partner recipients: `/Users/hironguyen/.codex/visualizations/2026/08/23/discount-provider-review/04-polish-implemented.png`
- Route: `http://app.localhost:8888/we/program/groups/default/discounts?discountId=disc_1M0JSAZ0HEBMZNAXDHATF9CH8`
- Viewport: 1450 × 1233 CSS pixels.
- Capture density: 1 CSS pixel to 1 image pixel; all polish captures are 1450 × 1233 pixels, so no density normalization was required.
- State: existing Shopify discount, campaign editor collapsed, recipient list collapsed.

## Comparison result

The edit sheet now separates three concepts that were previously mixed together: the Shopify campaign connection, the customer-facing discount, and partner code distribution. The disabled provider selector, editable-looking campaign field, raw configuration JSON, duplicate Shopify Admin links, emoji callout, and ambiguous `To` recipient label are absent from the default view.

The implementation preserves the existing Dub card, connector, typography, spacing, border, color, sheet, and sticky-footer primitives. It adds only progressive disclosure for changing the linked campaign, so the primary read path remains compact.

## Interaction and accessibility QA

- `Change campaign` reveals the existing labelled Shopify campaign input.
- `Cancel change` restores the original campaign ID and hides the input without submitting.
- The update action is disabled in the clean edit state, enabled after the campaign ID changes, and disabled again after `Cancel change` restores the saved value.
- Campaign editing is labelled `New Shopify discount code or ID`; the connection summary and Shopify Admin link continue to identify the currently saved campaign while the replacement value is unsaved.
- Exactly one `Open in Shopify Admin` link is present in the default edit state.
- The partner-recipient control exposes `aria-expanded` and a text action name that changes between expand and collapse.
- The expanded recipient table remains readable without horizontal scrolling at the reference viewport.
- A truncated recipient email reveals its complete value in a tooltip on pointer or keyboard focus. The full address also remains available to assistive technology in the table cell.
- Connection status uses both icon and text; state is not communicated by color alone.
- No form submission or discount mutation was performed during browser QA.
- Browser console errors: none. One pre-existing dialog-description warning remains outside this polish scope.

## Fidelity surfaces

- Fonts and typography: unchanged from the approved editor; the new campaign label uses the existing field-label size, weight, and line height.
- Spacing and layout rhythm: unchanged. The tooltip renders outside the table flow and does not create horizontal scrolling or move the sticky footer.
- Colors and visual tokens: unchanged. The disabled action, input focus, and tooltip continue to use existing Dub tokens.
- Image and icon fidelity: unchanged; no assets, logos, avatars, or icons were replaced.
- Copy and content: the campaign field now distinguishes the new value from the saved campaign, while the recipient tooltip exposes the full email without lengthening the table.
- Full-view comparison: the three-section hierarchy, sheet width, card spacing, and footer placement match the approved source states.
- Focused-region comparison: the campaign field and recipient email cell were compared at the same viewport because those are the only modified regions.

## Findings and revision history

- P2 fixed: the recipient summary initially mixed preview avatars with a trailing group name, producing an uneven gap. The discount context now shows the explicit count in one sentence.
- P2 fixed: the initial implementation said codes were already issued, while the available count represents approved partners. Copy now says `Codes for 3 partners in Default Group` and does not claim provisioning success that the current data contract cannot prove.
- P3 fixed: truncated recipient emails now expose their complete value through a focusable tooltip.
- P3 fixed: `Update discount` now reflects React Hook Form's dirty state and remains disabled until a real value changes.
- P3 fixed: campaign replacement uses an explicit `New Shopify discount code or ID` label while retaining the saved campaign in the connection summary.
- No P0, P1, or P2 visual or interaction defects remain in the verified flow.

final result: passed

---

# Design QA: Weletic points expiry parity

## Visual truth

- Smile reference: `/tmp/smile-loyalty-points-expiry-same-viewport.png`
- Final Weletic implementation: `/tmp/weletic-loyalty-points-expiry-actual.png`
- Viewport: 1280 × 720 CSS pixels for both captures.
- Source state: Smile points expiry disabled, with its one-year period and 30/3-day notification thresholds visible.
- Implementation state: Weletic staging points expiry enabled for one year, with the same 30/3-day thresholds and consent controls visible.

## Fidelity and interaction result

- The Weletic form preserves the existing dashboard navigation, typography, cards, controls, spacing, and responsive grid instead of copying Shopify Admin chrome.
- Smile's supported periods are all present: 3 days, 7 days, 1/2/3/6 months, 1 year, and 2 years, plus a Weletic `Never expire` state.
- Warning and last-chance thresholds are explicit, independently enabled, and grouped with the expiry period in one policy card.
- The configuration was saved through the signed-in Weletic workspace session, reloaded from the real staging API, and persisted as one year.
- Live customer-account QA confirmed the Loyalty Hub renders `Points expire after 12 months without qualifying activity.`
- No content overlap, clipped controls, or unintended horizontal scrolling is present at the verified viewport.
- A pre-existing missing-workspace-context defect in the loyalty dashboard client was found during interaction QA and fixed; the dashboard now renders real tenant data and persists mutations.
- No P0, P1, or P2 visual, responsive, accessibility, or interaction defect remains in this flow.

final result: passed

---

# Design QA: Weletic Loyalty Hub parity

## Visual truth

- Smile reference: `/tmp/smile-loyalty-hub-reference-same-viewport.jpg`
- Final Weletic implementation: `/tmp/weletic-loyalty-hub-actual-final.jpg`
- Same-viewport comparison: `/tmp/smile-weletic-loyalty-hub-compare-final.jpg`
- Customer-account viewport: 1407 × 1234 CSS pixels.
- Screenshot dimensions: 1407 × 1234 pixels for both source and implementation; device pixel ratio 2 was held constant by the Shopify account browser.
- Source state: signed-in Yamax customer, 0 Smile points, Bronze tier, two available coupons.
- Implementation state: the same signed-in Yamax customer, 0 Weletic points, Member tier, two available Weletic free-product vouchers.

## Fidelity and responsive result

- The Hub uses Shopify customer-account web components, typography, spacing, sections, badges, buttons, progress, and account navigation instead of a parallel storefront design system.
- At the verified desktop width, the branded program surface occupies the wide left column and the points and VIP summaries stack in the narrow right column, matching Smile's primary information hierarchy.
- Reward-wallet cards use a responsive two-column grid and keep metadata, code, and actions within each card without overlap.
- Spend, earning, campaigns, referrals, VIP tiers, points/referral/VIP activity, and reward history continue below the captured viewport in native account sections.
- The implementation accepts a tenant-configured HTTPS hero image. The staging program has no hero configured, so the branded surface intentionally renders its copy-only fallback; no Smile asset or approximate placeholder was copied.
- At narrow container widths, the summary and reward grids collapse to one column through Shopify query containers.

## Interaction and runtime checks

- `Copy code` and `Copy link` expose explicit accessible action labels.
- Available vouchers include a Shopify storefront `Use reward` link; unaffordable catalog rewards remain disabled with a visible points requirement.
- Facebook, X, and email referral actions are derived from the provisioned tracked referral link.
- Points, Referrals, and VIP activity tabs render distinct empty or populated states.
- Accessibility snapshots expose the expected page title, headings, lists, progress labels, coupon codes, tier state, and action names.
- Final live reload completed without an application console error. Shopify emitted its existing analytics-manager warning and used the platform no-op fallback.

## Findings and revision history

1. The first live pass retained a narrow account-page width and stacked reward cards, leaving excessive desktop whitespace. The page now uses Shopify's large full-page width and auto-fitting reward columns.
2. The second pass attempted a responsive 2:1 summary grid without a query container, so Shopify ignored the conditional columns. Wrapping the grid in `s-query-container` activated the documented desktop layout.
3. The final pass removed cross-column stretching for the copy-only branding fallback. The status cards retain their intrinsic height while an eventual configured hero can fill the wide brand surface.
4. Live data QA exposed an invalid scalar `tags` value while provisioning a referral link. The link now upserts tenant-scoped tags and creates the correct `LinkTag` relations.
5. No P0, P1, or P2 visual, responsive, accessibility, or interaction defect remains in the verified Hub flow. The missing staging hero is a P3 tenant-branding configuration gap, not a rendering defect.

Shopify release: `loyalty-hub-parity-final-2026-08-31` (`1109794553857`).

final result: passed

---

# Design QA: Shopify Customer Account Rewards

## Visual truth

- Native Shopify Orders reference: `/Users/hironguyen/.codex/visualizations/2026/08/29/rewards-ui-audit/02-orders-native.png` (1280 × 720)
- Previous Profile implementation: `/Users/hironguyen/.codex/visualizations/2026/08/29/rewards-ui-audit/04-profile-after-load.png` (1280 × 1376)
- Final Rewards implementation: `/Users/hironguyen/.codex/visualizations/2026/08/29/rewards-ui-audit/14-rewards-final.png` (1280 × 1432)
- Final compact Profile implementation: `/Users/hironguyen/.codex/visualizations/2026/08/29/rewards-ui-audit/16-profile-final.png` (1280 × 797)
- Full-view comparison: `/Users/hironguyen/.codex/visualizations/2026/08/29/rewards-ui-audit/17-design-qa-final-comparison.png`
- Focused before/after comparison: `/Users/hironguyen/.codex/visualizations/2026/08/29/rewards-ui-audit/18-design-qa-final-focused.png`

The screenshots use a 1280-pixel-wide Shopify customer-account viewport. Shopify controls the responsive content column and device scale. The signed-in staging customer is Hiro Nguyen on Yamax, with 0 points, Member tier, two available rewards, one cancelled reward, and one disabled redemption.

## Findings

- P0/P1/P2: none.
- The full Rewards hub now follows Shopify's native page width, typography, spacing, card, button, badge, and loading-state conventions.
- Reward cards no longer overlap at the narrow customer-account content width. Discount metadata and actions have explicit vertical grouping.
- Profile now shows only a compact points, tier, available-reward count, and `View rewards` summary; the previous full dashboard no longer displaces native profile content.
- Disabled redemption includes the visible explanation `Earn 100 more points to redeem.`
- A P3 duplicate `Cancelled` detail discovered in the first implementation pass was removed. The final live screenshot and accessibility snapshot show the status once.
- No custom images or approximate assets were introduced; the implementation uses Shopify customer-account web components and native icons.

## Interaction and runtime checks

- `View rewards` navigates from Profile to the full Rewards route.
- `Copy code` updates Shopify's accessible status/tooltip to `Copied`.
- Available reward links contain the expected Shopify storefront discount URL.
- Disabled `Redeem` remains non-interactive and has an adjacent explanation.
- Rewards and Profile accessibility snapshots expose the expected headings, lists, action labels, and link destinations.
- Browser console checks on the final Rewards and Profile release found no errors. Shopify emitted one platform warning about a missing analytics manager and used its no-op fallback.

## Comparison history

1. Initial audit found dense, ungrouped content and visible text overlap in both Rewards and Profile.
2. The Rewards hub was rebuilt as a native `s-page` with sectioned card lists, responsive action groups, and stable loading placeholders.
3. Profile was reduced to a compact summary and the generic order-status placement was retired.
4. Live release QA found one duplicated cancelled-status line; it was fixed, redeployed, and rechecked in the final combined comparison.

Shopify release: `loyalty-native-ui-2026-08-29-v2` (`1107362611201`).

final result: passed
