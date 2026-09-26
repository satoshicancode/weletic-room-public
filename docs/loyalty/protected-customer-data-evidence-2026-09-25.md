# Public-app protected customer data evidence packet

Read-only baseline, September 25, 2026 JST. The **public** Weletic Loyalty
Reviews Dev app's Partner Dashboard request is `New Draft`. Its data-protection
details show **0 of 9 questions completed**. This is distinct from any approval
for the retained custom app. No answer was selected or saved in the dashboard.

Shopify requires a public app using protected customer data to request the
minimum necessary resources and individually request identifying fields. Use
of name, address, phone or email adds its level 2 controls. Approval can redact
unapproved fields or return GraphQL errors with HTTP 200, so the accepted app
must handle those responses explicitly. A limited-visibility listing still
undergoes the same app review.
[Protected customer data requirements](https://shopify.dev/docs/apps/launch/protected-customer-data),
[review process](https://shopify.dev/docs/apps/launch/app-store-review/review-process).

## Nine dashboard questions

These are evidence dispositions, **not proposed Yes/No answers**. A code test
or a custom-app grant cannot prove public-app policy or provider controls.

| Dashboard subject                           | Existing evidence                                                                                                                                                                                                                                                                                                                                                                                                                              | Release evidence still needed                                                                                                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minimum personal data                       | The [public app manifest](../../packages/shopify-app/shopify.app.loyalty-public.toml) declares order/customer scopes and compliance webhooks. [Owner privacy projections](review-incentive-privacy.md) and [pseudonymous analytics exports](analytics-report-coverage.md) limit some downstream exposure.                                                                                                                                      | Inventory each actual public-app API query, webhook payload, stored field, email and export against a named feature and the exact protected fields requested. Remove or disable unused fields/scopes before selecting them.                                           |
| Merchant notice and purposes                | The [reviewer packet](app-store-reviewer-packet.md) requires accurate listing and privacy disclosures.                                                                                                                                                                                                                                                                                                                                         | Verify hosted privacy/support URLs, entity, subprocessors, retention, data use and purpose wording against the frozen enabled capability list. No approved public merchant notice is established by this packet.                                                      |
| Processing limited to stated purposes       | Store/installation fences and owner-only exports have local test coverage in the [completion matrix](company-store-completion.md).                                                                                                                                                                                                                                                                                                             | Compare live provider payloads, logs, exports and staff journeys to the published purpose statement; run installed tenant-isolation and misuse tests.                                                                                                                 |
| Merchant privacy/data-protection agreements | No executed merchant agreement is evidenced in the checked release documents.                                                                                                                                                                                                                                                                                                                                                                  | Product owner/legal review of the actual merchant agreement or privacy terms and their acceptance path; record the approved artifact and scope. Do not infer agreement from installation alone.                                                                       |
| Customer consent decisions                  | Product and store review submission require publication consent in the [account UI](../../packages/shopify-app/extensions/weletic-customer-account/src/CustomerAccountReviews.tsx) and [store-review UI](../../packages/shopify-app/extensions/weletic-customer-account/src/CustomerAccountStoreReviews.tsx). [Delivery tests](../../apps/web/tests/weletic/communication-delivery-snapshot.test.ts) exercise consent and privacy suppression. | Prove current Shopify consent and revocation behavior in the installed app and actual sender, including queued retries. The shopper UI explicitly labels consent history unavailable; a marketing flag alone is not consent evidence.                                 |
| Customer opt-out of data sale/sharing       | External ESP and syndication are outside v1 scope.                                                                                                                                                                                                                                                                                                                                                                                             | Establish the actual data-sharing/subprocessor policy and an opt-out path where applicable. Do not select `Not applicable` solely from the feature exclusion; confirm the legal and operational facts.                                                                |
| Consequential automated decisions           | Loyalty points/VIP and review moderation are documented feature behavior, but this packet does not classify their legal effects.                                                                                                                                                                                                                                                                                                               | Product owner/legal determination of whether any personal-data decision has legal or similarly significant effect, and an opt-out/manual process if applicable.                                                                                                       |
| Retention periods                           | [Compliance webhook tests](../../apps/web/tests/weletic/shopify-central-compliance-webhook.test.ts), [review privacy tests](../../apps/web/tests/weletic/review-content-privacy.test.ts) and [retention-related design](review-incentive-privacy.md) cover local paths.                                                                                                                                                                        | Publish per-data-class retention, then prove scheduled deletion, private-object cleanup, provider logs/dead letters, backup expiration and export/erase races in the release environment. Preserve required financial history without retaining unnecessary identity. |
| Encryption at rest and in transit           | Private export/media design is documented in the [reviewer packet](app-store-reviewer-packet.md). The [resource inventory](release-resource-inventory-2026-09-20.md) explicitly leaves SQL, Redis/QStash and backup protection unverified.                                                                                                                                                                                                     | Verify TLS on every provider edge and exact SQL/R2/Redis/QStash/email storage and backup settings. Do not answer Yes from application-level encryption or the presence of an R2 bucket alone.                                                                         |

## Additional level 2 and submission gates

Before submitting a request that includes identifying fields, record evidence for encrypted backups,
separate synthetic/test and production data, data-loss prevention, restricted
staff access, strong staff authentication, protected-data access logs and an
incident-response policy. These are Shopify's level 2 requirements in addition
to the dashboard's nine prompts. The [release resource packet](release-resource-inventory-2026-09-20.md)
and [reviewer packet](app-store-reviewer-packet.md) currently leave provider,
restore and policy proof open.

Freeze the exact public app version, required scopes, protected resources and
individual name/email/phone/address fields after feature acceptance. Compare
the active version with the [local manifest](../../packages/shopify-app/shopify.app.loyalty-public.toml),
because the current remote version and local extension selection differ.
Rehearse approved and redacted Shopify responses, complete only supported
dashboard answers, and capture the submitted request and later approval as
separate evidence. Listing submission and production activation retain their
separate approvals.

## September 26 core-launch addendum

The [core checklist](core-launch-checklist.md) supersedes parity-oriented purposes.
Start the public request from these enabled purposes; do not request fields merely
because a deferred model or prior custom app used them:

| Data                                                                                           | Enabled purpose                                                                    | Evidence/gap                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Immutable shop/customer/order/product/line IDs, merchandise amounts, fulfillment/refund events | Tenant identity, exact loyalty accounting, verified purchase and invitation timing | Existing ledger/order/refund contracts; installed public response and webhook evidence required               |
| Customer email                                                                                 | Transactional review invitation and existing obligation communications             | Sender, actual inbox, encrypted delivery snapshot and erasure evidence required                               |
| Customer display name                                                                          | Wallet greeting and consented review author display                                | Verify minimum fields actually collected and displayed; no phone/address purpose is established by this scope |
| Text/photo review and publication consent                                                      | Verified product review, manual moderation/reply/display                           | Private photo read/delete and export/erase race proof required                                                |
| Shop GID, plan handle/status, verification/cycle timestamps, installation generation           | Subscription access, cancellation and refresh fencing                              | New snapshot contains no payment-card data or buyer fields; shop-redaction paths remove it                    |

Phone/address and unrelated demographic fields have no approved core purpose.
Complete a payload/retention audit of shared ingestion before claiming those
fields are not collected; do not select dashboard approval for them by default.
No data is used for external merchant growth, advertising, video, referrals, VIP
or historical imports in this release. This statement does not erase existing
retained records or obligations.

The [resource packet](core-launch-execution-packets.md) now selects separate
SQL/Redis/QStash/R2/email resources and includes security add-on costs. These are
proposed controls, not deployed encryption or backup evidence. Dashboard answers,
legal entity/privacy terms, retention policy, actual protected-field inventory,
provider proof and submission remain uncompleted. Never mark the nine answers
complete from local test results alone.
