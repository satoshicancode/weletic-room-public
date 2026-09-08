# Shopify staff access: evidence and accepted owner decision

Investigation dated 2026-09-07, based on local parent `795e8440a0` and installed
Shopify SDKs. Package 8 remains incomplete. This document is a proposal, not
authorization to change authentication, deploy schema, grant access or activate
either store. Hiro subsequently approved verified Shopify-owner administration
on 2026-09-07; [ADR 0018](../adr/0018-shopify-owner-and-store-scoped-staff-access.md)
records that decision. Implementation and release evidence remain outstanding.

The subsequent [online-session persistence step](./shopify-online-session-evidence.md)
addresses the serialization/coercion findings locally. It does not enable staff
authorization or close the remaining installation/permission boundaries below.

## Findings that determine implementation

The embedded dashboard calls `authenticate.admin(request)`, then forwards only
`session.shop` to internal stats, catalog and review-health endpoints. The
catalog action likewise forwards shop plus an empty body. Internal HMAC proves
the calling service and signed request, not the staff member's app permissions.
The stats route currently returns affiliate aggregates and partner names; that
data must not silently become readable under a generic loyalty/reviews grant.
These are source findings, not a demonstrated live unauthorized request.

Relevant production paths:

- `packages/shopify-app/app/routes/_index.tsx`
- `packages/shopify-app/app/weletic-api.server.ts`
- `apps/web/app/api/internal/shopify/stats/route.ts`
- `apps/web/app/api/internal/shopify/catalog/route.ts`
- `apps/web/lib/api/rbac/permissions.ts`

Shopify's [token contract](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens)
distinguishes user identity from authorization: an ID token has no permissions;
online access tokens represent a staff member, including effective scopes and
owner status. An installation or an offline app token is not owner evidence.

The app currently configures expiring offline tokens but not `useOnlineTokens`.
Shopify documents enabling online tokens **alongside** offline tokens through
that setting, so background renewal should be retained, not replaced. See
[template authentication](https://shopify.dev/docs/apps/build/authentication-authorization/cli-app-authentication).
The installed Remix SDK supports the setting. Its token-exchange strategy can
exchange an offline token before an online token when the user session needs
renewal; the existing cross-process offline coordination must remain effective
during that path.

There is an additional local persistence constraint: `WeleticSessionStorage`
round-trips `Session.toPropertyArray(true)` / `Session.fromPropertyArray(..., true)`.
The installed SDK's serializer preserves user identity/owner fields but omits
`associated_user_scope`. A synthetic, network-free execution reproduced:

```json
{
  "originalUserScope": "read_products",
  "restoredUserScope": null,
  "restoredAppScope": "read_products,write_discounts",
  "restoredUserId": 123,
  "userScopePersisted": false
}
```

Never substitute the broader restored `session.scope` for missing user-scope
evidence. Simply enabling the SDK flag would not complete this requirement.
Online session writes also bypass the offline coordination override and use the
legacy session endpoint; its lifecycle checks are not proof of original online
installation-generation binding. Add explicit online identity/scope/generation
evidence, then test stale load/write/delete behavior across reinstall.

The same hydration path coerces owner/collaborator values with `Boolean(value)`.
A second synthetic execution confirmed string `"false"` becomes boolean `true`
for both fields. The current generic session-property schema accepts strings;
future owner authorization must strictly validate original booleans before SDK
hydration, not infer authority from coerced or legacy records. This is a latent
owner-bootstrap hazard, not evidence that the current offline app grants owner
access through that field.

## Accepted owner-access decision

Who can administer Weletic's store-scoped roles when the Shopify owner does not
have a separate Weletic workspace account?

**Recommended: verified Shopify owner administration.** A freshly authenticated,
verified Shopify account owner can administer this store's loyalty/reviews and
assign bounded staff roles inside Shopify. Other staff and collaborators start
without a grant. This grants no Dub workspace ownership, affiliate/payout/billing
access, cross-store authority or infrastructure-release permission. Existing
Weletic workspace-owner access remains a distinct administrative path.

**Alternative: workspace-owner bootstrap.** A Weletic workspace owner must first
link and approve every Shopify administrator, including the Shopify owner. This
centralizes authority but introduces an out-of-Shopify onboarding dependency.

The original unified plan did not choose between those ownership policies; Hiro
has now approved the recommended Shopify-owner model in ADR 0018. Do not match
identities by email or convert a Shopify staff
member into a Partner or a Dub workspace owner.

## Proposed implementation contract after approval

- Authenticate with the existing Shopify SDK; bind verified user ID, app audience,
  canonical shop and current installation to an online session. Reject unsafe
  numeric IDs rather than rounding them. Missing owner/scope evidence denies
  privileged access; do not trust browser-supplied claims or decoded-only JWTs.
  Require actual booleans in authenticated owner/collaborator evidence before
  hydration; malformed or legacy records cannot establish owner bootstrap.
- Preserve explicit effective-user-scope evidence in encrypted session storage,
  with expiry and original generation. Define a reviewed backward-compatible
  session envelope; old online records without evidence reauthenticate. Preserve
  offline credential/refresh leases, secret-safe logs and background behavior.
- Forward a bounded actor envelope inside the signed internal request, bound to
  method, path, body, timestamp and installation. Plain extra headers are not
  covered by the current signature. Resolve store/workspace ownership server-side.
- Persist store/user grants separately from `ProjectUsers` and Partner groups,
  with versioned changes, actor audit and revocation. Avoid replayable mutation
  authority: recheck grant, generation and operation-specific permission under
  the same transaction as each data change. Preserve idempotency and audit.
- Enforce explicit permissions for reads, customer data, moderation, configuration,
  financial exports/adjustments and access management. A review moderator does
  not acquire reward, affiliate or payout permissions. Deny by default.
- Shopify API calls initiated as a staff action must respect the online token's
  effective scopes and revocation; never retry denied calls with an offline token.
  Internal data actions also require app grants. User-specific caches are private.
- Reuse framework-neutral business services behind separate trusted workspace
  and Shopify actor adapters. Do not forge a workspace session or remove existing
  owner checks to make Shopify calls fit. Extend audit actors explicitly rather
  than place a Shopify user ID into the workspace `actorUserId` field.
- Cover current dashboard stats/catalog routes in the permission cutover, not
  just new loyalty/reviews screens. Separate affiliate navigation and data from
  native loyalty/reviews permissions. Preserve worker/webhook service routes;
  service authentication is not merchant authorization.
- Include staff identity, grant history and expired online sessions in merchant
  privacy/export/retention handling. Shopper privacy is a separate boundary.

Likely files: the Shopify authentication/session adapters and route loaders;
new Weletic-owned staff contracts/authorization services; internal merchant
gateways; additive session/grant/audit schema where required; shared merchant
interface permission adapters. No dependency upgrade, SDK patch, global fetch
override, general identity rewrite or CI change is assumed.

## Verification and release gates

Use production services and isolated MySQL for grant/revoke races, stale workers,
reinstall fencing, concurrent offline refresh plus online exchange, token replay,
grant version changes, cross-store identities and audit rollback. Include the
real SDK serialization regression and exact signed-envelope tamper cases.
Cover string/number/null owner flags as invalid instead of truthy booleans.
Gateway tests must exercise actual authentication boundaries, not only mocked
owner flags. Test missing user scopes, a user scope narrower than app scope,
online expiry/revocation, and no fallback to offline authority after a denial.

UI acceptance needs an actual owner, an explicitly granted staff identity and a
denied/ungranted identity on `yamaxdev`, where account/plan capabilities permit.
If the environment cannot host those identities, that is a live-proof gate,
not permission to claim mocked tests establish staff access. Test English,
Japanese and Vietnamese permission errors and inaccessible navigation.

Additive shared schema requires staged validation and specific merge/rollout
approval. No app-config deployment, external API mutation or store-access grant
is performed by this investigation. PR #73 received separate explicit merge
approval and merged as `8331cd95ff7e504131b4f2cc90a52423e2d69cc3`. That merge and
the owner-policy approval do not authorize shared deployment or subsequent schema
merges.
