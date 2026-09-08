# ADR 0018: Shopify owner and store-scoped staff access

- Date: 2026-09-07
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (implementation)

## Context

The unified loyalty/reviews product must support daily merchant administration
inside Shopify. Its approved plan requires explicit staff permissions, but does
not equate installing the app with owner authority or decide whether the Shopify
owner needs a separate Weletic workspace account to administer their store.

The existing embedded dashboard forwards shop identity through a signed service
boundary. That identifies the service and store, not the staff member's allowed
operations. Dub workspace membership and Partner groups serve different actors;
reusing either as Shopify staff identity would grant unrelated authority or force
an unnecessary out-of-Shopify enrollment workflow.

The installed Shopify SDK supports online sessions alongside the coordinated
offline credentials used by background work. Local investigation also reproduced
loss of effective user scopes during session-property serialization and coercion
of string owner flags to truthy booleans. Owner administration therefore requires
validated identity and permission evidence, not only a configuration switch.

## Decision

A freshly authenticated and verified Shopify account owner may administer
loyalty/reviews and assign bounded staff permissions for that store directly
inside Shopify, without a separate Weletic workspace account. Other staff and
collaborators have no app access until explicitly granted. This authority never
creates Dub workspace ownership, affiliate/payout/billing access, cross-store
authority or permission to bypass deployment and financial release gates.
Existing authenticated Weletic workspace-owner administration remains separate.

Bind staff identity to the canonical store, app and installation generation.
Validate original owner/collaborator booleans and effective user scopes before
SDK hydration; missing or legacy/coerced evidence cannot establish ownership.
Keep online user authorization separate from coordinated offline worker tokens.
Use explicit store-scoped grants, revocation, actor audit and operation-specific
authorization through shared business services. Never match identities by email,
forge a workspace owner session, or retry a staff permission denial with an
offline token. Do not automatically restore former-owner authority after a
transfer or reinstall without current verified evidence.

## Alternatives considered

- **Weletic workspace-owner bootstrap for every Shopify administrator** —
  rejected because even the verified merchant owner would depend on an external
  account/linking step before using the Shopify-first product.
- **Treat every authenticated app user as an owner** — rejected because staff
  and collaborator access must not imply financial or access-management rights.
- **Reuse Dub workspace or Partner membership** — rejected because these actors
  have different ownership, privacy and permission boundaries.

## Consequences

### Positive

- Store owners can administer the product inside Shopify without duplicate
  account onboarding.
- Staff grants are explicit and store-scoped; unrelated Dub and affiliate
  authority remains protected.
- Workspace and Shopify interfaces can share business services without sharing
  or fabricating their authentication contexts.

### Negative / trade-offs accepted

- Online session evidence, grants, revocation and audits require additional
  implementation and lifecycle/retention handling.
- Owner changes, missing scope evidence, expired sessions and reinstall races
  must fail closed even when this requires reauthentication.
- Real owner/staff/denied-user acceptance cannot be replaced by mocked role flags.

### Follow-ups

- Implement the session evidence, signed actor boundary and store-scoped grants;
  cover existing dashboard/catalog routes as well as new loyalty/reviews screens.
- Preserve offline refresh coordination and prohibit offline fallback after staff
  authorization failure. Test real SDK serialization and MySQL race boundaries.
- Add merchant staff export/retention and three-locale permission UX; verify live
  owner, granted staff and denied identities on `yamaxdev` when available.
- Stage any additive schema only in the isolated environment. Shared-schema
  merge/rollout, external sends and store/extension activation remain separately
  gated. Approval of this ADR does not deploy anything.

## References

- Hiro explicitly approved both the proposed Shopify-owner model and the
  separate PR #73 merge in this task on 2026-09-07.
- [Staff-access investigation](../loyalty/shopify-staff-access-design.md).
- [Unified completion plan](https://www.notion.so/3d2e26097bfd81c0a667ce21978d4fdc).
- [PR #73](https://github.com/satoshicancode/weletic-room/pull/73), merged as
  `8331cd95ff7e504131b4f2cc90a52423e2d69cc3`; this is code-merge evidence, not
  database deployment or live acceptance.
