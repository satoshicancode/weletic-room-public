# Core loyalty and reviews public app — reviewer packet draft

Updated September 27, 2026. **Not submission-ready; not submitted.**
The [core launch checklist](core-launch-checklist.md) and [ADR 0045](../adr/0045-core-loyalty-reviews-launch.md)
supersede this packet's September 20 company-only/free policy. This draft prepares
review instructions; it establishes neither Shopify approval nor production activation.

## Distribution and claims

Proposed listing description, usable only after core journey acceptance:

> Purchase points, fixed-value rewards and verified product reviews for Shopify.
> Includes customer wallet/history, optional photo reviews, merchant moderation
> and Shopify Flow integration. US$500/month; no trial. Private company plans are
> assigned individually. Basic support is available through the listed contact.

Approved commercial policy: one Shopify-hosted US$500 monthly public plan and one
private free company plan; no public trial, annual tier or usage pricing. Outside
merchants who subscribe receive the same launched features and basic support.
The price discourages installation but does not prevent it. Choose limited
visibility explicitly; it does not exempt the app from review or quality requirements.
[Shopify visibility](https://shopify.dev/docs/apps/launch/distribution/visibility),
[review process](https://shopify.dev/docs/apps/launch/app-store-review/review-process).

Freeze the exact core profile, reward types, extensions and workflows against
named installed evidence. Purchase earning is for eligible one-time merchandise;
redemption uses fixed-value native discounts. Reviews are verified product text
and optional photos, with one disclosed participation-points award per order,
independent of rating or publication. Manual publication, seven-day invitations,
thirty-day validity and no reminders are the initial defaults. No historical
imports or invitation sends are included.

Do not advertise VIP, referrals, campaigns, subscription earning, store reviews,
open submissions, review coupons or photo bonuses, video, Q&A, imports, POS or
Plus-only checkout extensions. The required theme/account and Flow bundle has
its own publication gate. Product review incentives never concern App Store reviews.

## Reviewer access — verified installation and subscription

Before submission designate a monitored support contact and a tested reviewer
access procedure. Neither the hosted contact URL nor response SLA is verified
in this draft. Hosted pricing setup remains inaccessible in the observed
unregistered account; Hiro has deferred registration and its fee. Local
synthetic snapshots are test fixtures, never reviewer access credentials.

1. Reviewer installs the public app and opens it inside authenticated Shopify
   Admin. Verify the immutable app/shop identity and installation generation.
   Installation or a pricing redirect alone grants no benefit access.
2. Exercise Shopify-hosted plan selection and return through the actual approved
   review/test billing path. Record the configured plan handles and any exact
   store assignment privately. Do not require an unapproved real charge merely
   to demonstrate the app, or invent a private entitlement in SQL.
3. The server confirms Partner `activeSubscription` and persists app/shop/generation
   authority. Verified eligible subscriptions can provision access without manual
   company approval. Private-free company access must match the configured plan;
   development no-charge access also requires authenticated development-store status.
4. Show pending/unverified, declined selection, forged return, API-unavailable,
   cancellation and expired-verification states. New benefits pause when authority
   expires. Existing refunds, settlements and privacy processing continue under
   their existing authorization and installation fences.
5. Authenticate owner and restricted staff normally. Explicit suspension, privacy
   restrictions and reinstall fencing remain authoritative even with a valid plan.
   Reinstall requires fresh generation-bound verification; never synthesize a
   staff session, manually override a subscription, or expose credentials.
6. Demonstrate only enabled core journeys using approved disposable fixtures.
   Record cancellation guidance, support and billing status alongside recovery
   states. No separate SaaS registration or Stripe checkout belongs in this path.
7. At completion, execute only the approved exact fixture/access cleanup packet.
   Preserve financial/audit history and prior apps; no blanket deletion or app
   retirement is implied by review completion.

Legacy company-store operator scripts remain recovery/administrative tools;
they are not the normal subscriber or reviewer onboarding path. Source tests and
local fixtures do not prove this installed journey. Freeze private runtime
instructions, exact identities, billing path and operator availability before
submission, without publishing secrets in this document.

## Reproducible reviewer journey

Supply exact URLs and test credentials only in Shopify's private review fields.
Record release SHA/image digest, store plan, locale, active modules, extensions
and cleanup owner. Use a persistent reviewed environment, not a laptop tunnel
whose lifetime is unknown. Complete these journeys before offering them:

- Install/open/reopen/reinstall; owner and restricted staff; multi-tab recovery;
  pending/suspended store; verified hosted pricing, cancellation/freeze, unavailable
  Partner API, cross-store isolation and reinstall. No separate SaaS account.
- Loyalty: approved one-time test purchase → points → fixed-value native coupon →
  checkout use → partial/full refund; exact balance/history evidence, duplicate handling and clear unsupported
  capabilities. No page-render points and no fabricated order/renewal proof.
- Reviews: approved invitation → real inbox → scoped single-use submission →
  moderation/reply → widget, including a genuine low rating. Disclose an optional
  saved participation-points incentive before submission, at most once per order;
  no automatic enrollment. Include private-photo deletion and token expiry/reuse.
- EN/JA/VI, mobile/keyboard, expired session and loading/error/permission states
  for each enabled surface. List the actual required theme/account placements.
- Real Flow receipts for points earned, reward redeemed, review submitted and
  review published, plus the owner-authorized bounded points action. Include
  duplicate/revoked/disabled/stale-generation behavior and no recursive awards.
  Built-in review rewards remain the sole automatic participation-award writer.
- Privacy/support: reachable policy/contact links, data access/erasure evidence,
  revoked authority, uninstall containment and no private identifiers in UI/logs.

## Protected customer data gate

The public-app manifest requests `read_orders` and subscribes to customer, order
and refund events; the account and delivery journeys can use customer names or
email. Treat [Shopify's level 2 protected customer data requirements](https://shopify.dev/docs/apps/launch/protected-customer-data)
as the expected submission gate unless an exact deployed-field inventory proves
a narrower use. Development-store access does not establish approval for a
published public app. This packet has not verified the Partner Dashboard grants.

Before freezing the reviewer build, record the exact public app/client ID,
version, release SHA and installation generation. Compare its granted scopes and
protected fields with the deployed Admin API queries, Customer Account API calls,
webhooks and enabled module journeys. Request protected customer data access and
each necessary identifying field in the Partner Dashboard, with its specific
purpose and data protection details. Keep fields that lack an approved purpose
out of queries and payloads. Test the accepted app's actual response to an
unapproved or redacted field: Shopify can return HTTP 200 with GraphQL errors or
null fields, and the journey must fail safely rather than silently use partial
identity. Capture grant status and the real response as evidence.

The submission evidence must point to the implemented controls for minimum data
use, merchant notice and stated purposes, applicable consent/opt-out handling,
retention and erasure, encryption in transit and at rest, encrypted backups,
separate test/production data, data-loss prevention, restricted staff access,
access logs and incident response. Verify provider and backup settings in the
release environment; local code and a development-store grant alone do not
close this gate. Keep the app ready to supply this evidence if Shopify requests
a data protection review. The [review process](https://shopify.dev/docs/apps/launch/app-store-review/review-process)
applies the same app requirements to limited-visibility listings.

## Submission blockers and evidence required

| Gate                | Required evidence                                                                                       | Current disposition                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Persistent release  | Isolated providers, production manifests, HTTPS origins, backup/restore, monitoring                     | Open; see resource inventory                                        |
| Reviewer admission  | Exact authenticated install/hosted-pricing/verification/reinstall journey                               | Not executed by this packet                                         |
| Enabled modules     | Named live matrix per submitted capability, including failure/privacy paths                             | Incomplete; bounded loyalty evidence is not whole-module acceptance |
| Shopify permissions | Least-privilege manifest/runtime agreement, extension ownership, protected-data/network approvals       | Not certified here                                                  |
| Protected data      | Exact approved fields, data-protection controls and redaction/error journey on the submitted public app | Dashboard grants and release-environment controls unverified        |
| Public materials    | Approved entity/contact, hosted privacy/support URLs, accurate data/retention/subprocessor disclosures  | Not verified or published                                           |
| Listing assets      | Original Weletic screenshots/assets matching the accepted build, no shopper identifiers                 | Not prepared/accepted                                               |
| Submission          | Final metadata/screenshots/reviewer instructions checked against current Shopify requirements           | Requires separate explicit execution approval                       |
| Production          | Separate weletic.com module rollout and rollback packet                                                 | Not authorized by App Store submission                              |

No credentials, customer data, provider sends, listing edits or live store changes
were made while preparing this draft. No gate is closed by this document alone.
