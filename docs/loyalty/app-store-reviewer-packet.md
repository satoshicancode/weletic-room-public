# Company-store public app — reviewer packet draft

September 20, 2026. **Not submission-ready; not submitted.**
This prepares S06, not Shopify approval or production activation.

## Distribution and claims

Proposed listing description, usable only after enabled-module acceptance:

> Manage loyalty and customer reviews for approved Weletic company stores from
> Shopify Admin. Enable each module independently. Store approval is required;
> this app is not a self-service service for unrelated merchants.

Pricing: free; no app billing, pricing tiers or external-merchant onboarding.
Choose limited visibility explicitly. A direct listing URL does not restrict who
can attempt installation; backend admission remains necessary. Limited visibility
does not exempt the app from review or quality requirements.
[Shopify visibility](https://shopify.dev/docs/apps/launch/distribution/visibility),
[review process](https://shopify.dev/docs/apps/launch/app-store-review/review-process).

Do not advertise all plan capabilities as available. The exact submitted build
must have a frozen list of enabled modules, rewards, extensions and workflows,
each linked to named live evidence. Omit pending video/Q&A/import/subscription
claims until accepted. Explain plan-ineligible surfaces; do not imply public
distribution unlocks Plus-only checkout UI. Incentives concern store/product
feedback, never App Store reviews, and must not depend on rating/publication.

## Reviewer access — audited, no authentication bypass

Before submission designate a monitored support contact and approved reviewer
access procedure. Neither contact URL nor response SLA is verified in this draft.

1. Reviewer installs the existing public registration through the provided
   Shopify listing/install flow and opens it inside authenticated Shopify Admin.
2. An unknown store remains `pending_approval`. It may authenticate and perform
   mandatory privacy handling, but must not sync customers or run module writers.
3. Verify the review request through Shopify's review channel. Obtain an explicit
   temporary reviewer-store admission approval bound to the exact app, canonical
   shop and current installation generation. Do not approve arbitrary owners
   merely because they can install the app.
4. Operator privately previews `bootstrap-company-shopify-store.ts` using its
   strict app/shop/pending/generation/revision/operator/reason inputs. If mapping
   is absent, apply only the approved exact preview digest. Never adopt existing
   orphan records or create a fictitious Weletic user.
5. Complete fresh native Shopify authentication after mapping. Then preview
   `set-shopify-store-access.ts` with exact store/domain/generation/revision and
   audited operator/reason; apply `active` only under the approved reviewer-store
   packet. This is a trusted operator action, not a merchant API or reviewer shell
   instruction. Do not expose database credentials or tokens to the reviewer.
6. Demonstrate independent module controls using approved disposable fixtures.
   Reinstall creates fresh generation authority; rerun admission as required.
   Never modify auth rules or synthesize a staff session to keep a demo working.
7. At review completion, audit and suspend temporary access under the approved
   cleanup packet. Preserve financial/import/audit history; do not delete real
   customer records or uninstall old apps as implicit cleanup.

Both operator scripts exist on public main. Their existence does not prove this
complete reviewer journey live. Freeze private runtime instructions, exact
identifiers and operator availability before submission; do not paste private
preview output into this public document.

## Reproducible reviewer journey

Supply exact URLs and test credentials only in Shopify's private review fields.
Record release SHA/image digest, store plan, locale, active modules, extensions
and cleanup owner. Use a persistent reviewed environment, not a laptop tunnel
whose lifetime is unknown. Complete these journeys before offering them:

- Install/open/reopen/reinstall; owner and restricted staff; multi-tab recovery;
  pending/suspended store; no separate SaaS registration or billing requirement.
- Loyalty: approved test purchase → points → native reward → checkout use →
  refund; exact balance/history evidence, duplicate handling and clear unsupported
  capabilities. No page-render points and no fabricated order/renewal proof.
- Reviews: approved invitation → real inbox → scoped single-use submission →
  moderation/reply → widget, including a genuine low rating. Disclose an optional
  saved points-or-coupon incentive before submission; no automatic enrollment.
- EN/JA/VI, mobile/keyboard, expired session and loading/error/permission states
  for each enabled surface. List actual theme/account/post-checkout placements.
- Real Flow workflows for each advertised trigger/action, with event/run
  identity and no duplicate built-in incentive. Do not advertise draft manifests.
- Privacy/support: reachable policy/contact links, data access/erasure evidence,
  revoked authority, uninstall containment and no private identifiers in UI/logs.

## Submission blockers and evidence required

| Gate                | Required evidence                                                                                      | Current disposition                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Persistent release  | Isolated providers, production manifests, HTTPS origins, backup/restore, monitoring                    | Open; see resource inventory                                        |
| Reviewer admission  | Exact audited install/bootstrap/auth/approval/reinstall journey                                        | Not executed by this packet                                         |
| Enabled modules     | Named live matrix per submitted capability, including failure/privacy paths                            | Incomplete; bounded loyalty evidence is not whole-module acceptance |
| Shopify permissions | Least-privilege manifest/runtime agreement, extension ownership, protected-data/network approvals      | Not certified here                                                  |
| Public materials    | Approved entity/contact, hosted privacy/support URLs, accurate data/retention/subprocessor disclosures | Not verified or published                                           |
| Listing assets      | Original Weletic screenshots/assets matching the accepted build, no shopper identifiers                | Not prepared/accepted                                               |
| Submission          | Final metadata/screenshots/reviewer instructions checked against current Shopify requirements          | Requires separate explicit execution approval                       |
| Production          | Separate weletic.com module rollout and rollback packet                                                | Not authorized by App Store submission                              |

No credentials, customer data, provider sends, listing edits or live store changes
were made while preparing this draft. No gate is closed by this document alone.
