# ADR 0040: Company-store loyalty and reviews completion

- Date: 2026-09-20
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

The September 9 stream deliberately paused reviews to preserve the Smile
reference and finish company-store loyalty. Public main now includes bounded
yamaxdev financial evidence and the PR #85 merchant-read fix, but neither full
loyalty acceptance nor native reviews acceptance is complete. Historical reviews
documents disagree about scope and include superseded publication-based rewards.

Hiro approved resuming the full reviews product alongside loyalty, with staged
delivery and independent module release gates. Public distribution serves company
stores and Shopify capabilities, not a SaaS business. A public listing does not
remove Shopify plan restrictions or the App Store review requirement.

## Decision

Deliver loyalty and reviews as independently switchable modules of the same
Shopify-first app. Reviews include product/store feedback, text/photos/video,
verified invitations, unrewarded open submissions, moderation/replies, Q&A,
manual EN/JA/VI translations, and generic CSV plus Judge.me imports. Incentives
are an immutable points-or-coupon promise shared once per eligible order,
independent of rating/publication. Preserve historical contracts; do not activate
legacy publication rewards as the prospective policy.

Use a free limited-visibility public listing with audited company-store approval.
Target non-Plus theme/account, Flow and eligible post-checkout surfaces first;
Plus-only checkout, POS, external ESP/syndication and AI translation remain
excluded. Preserve local Docker + CLI acceptance and the ADR 0034 Cloudflare
Containers/R2/managed-services topology. Extend the ADR 0036 loyalty-only release
allowlist explicitly for reviewed reviews endpoints/workers, never with a broad
prefix grant or by exposing unrelated Dub portals.

The combined completion checklist is the current task/status authority; the
existing acceptance matrix retains its detailed loyalty requirement IDs and
historical evidence. Implementation/CI success does not certify live acceptance.
Spending, shared/production schemas, external sends/orders, publication,
production activation and legacy-app/provider retirement remain explicit gates.

## Alternatives considered

- **Core reviews only** — rejected: Hiro selected the full product delivered in
  usable stages, including video, imports, store feedback and Q&A.
- **One combined launch** — rejected: an unready module must not block a proven
  independently deployable module; unfinished behavior stays disabled.
- **Plus-first checkout** — rejected: non-Plus stores are the initial target;
  public distribution does not confer Plus eligibility.
- **Points-only or no incentives** — rejected: retain the existing points-or-
  coupon design with disclosure, exact ownership and one order-wide promise.
- **Generic CSV only** — rejected: add a Judge.me mapping, but require an
  authorized export before any real import/cutover.

## Consequences

### Positive

- One explicit scope replaces contradictory historical release statements.
- Shared identity, privacy, accounting and operations are reused without making
  reviews dependent on loyalty enrollment.
- Company stores can adopt verified modules without waiting for every extension.

### Negative / trade-offs accepted

- Extended reviews require new compatible records and media/worker capacity.
- Public listing review and target-provider acceptance remain external work.
- Full completion is broader than the previously approved loyalty-only stream.

### Follow-ups

- Maintain task-level evidence and dependencies in the combined checklist.
- Finish policy disclosure/activation and enrollment recovery before enabling
  prospective review rewards.
- Rehearse additive migrations and review each release allowlist addition.
- Present scoped external execution packets; do not infer resource budgets or
  authorize sends/orders from this product decision.

## References

- Hiro's approved “Complete Weletic Loyalty and Reviews for Company Stores” plan,
  September 20, 2026; full staged reviews, independent releases, non-Plus first,
  points-or-coupon incentives and CSV plus Judge.me choices.
- [Combined completion checklist](../loyalty/company-store-completion.md).
- [Cloudflare topology](0034-cloudflare-containers-managed-services.md).
- [Original release boundary](0036-loyalty-only-cloudflare-release.md).
- [Shopify checkout availability](https://shopify.dev/docs/apps/build/checkout/technologies).
- [Shopify listing visibility](https://shopify.dev/docs/apps/launch/distribution/visibility).
