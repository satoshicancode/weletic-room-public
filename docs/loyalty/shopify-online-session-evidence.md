# Online-session persistence evidence

Local implementation step for accepted [ADR 0018](../adr/0018-shopify-owner-and-store-scoped-staff-access.md),
2026-09-07. Not deployed or live-proven. This does not enable online tokens,
grant staff access, establish current owner authority or complete package 8.

## Changed contract

The existing encrypted session-property payload gains an optional canonical
`associatedUserScope` string. It preserves the Shopify online session's effective
user scopes independently of the broader app `scope`. Empty user scope is a
valid empty scope set, never a fallback to app scope.
No new table, credential store, token transport or environment setting is added.

The application serializer adds this value before sending the existing signed
session request. The deserializer restores it after SDK hydration. Both use a
framework-neutral validator shared with the backend write schema, which rejects
duplicate/unknown/case-variant property names, coercive boolean flags, unsafe or
non-positive numeric user IDs, and malformed user-scope strings. This prevents
the installed SDK from converting string `"false"` into owner `true` or rounding
an unsafe identity. It does not validate a browser token or grant app permissions.

Legacy payload parsing remains distinct from new-write validation. The storage
adapter treats online records with missing scope/identity/owner evidence or
invalid types as cache misses, including shop-session enumeration; the SDK can
reauthenticate rather than adopt unsafe evidence. The new app serializer requires
complete online persistence evidence. For compatibility, the backend still accepts
incomplete legacy writes, but the new reader treats those records as cache misses,
not authorization evidence. A retained offline record does not need these
online fields. Offline scopes, refresh credentials and coordinated renewal paths
retain their existing contract.

## Compatibility and rollout

Deploy the backend's expanded property allowlist before any app runtime writes
the additional field. The current app configuration still does not enable
`useOnlineTokens`; do not turn it on merely because this step passes. No existing
database payload is bulk rewritten or deleted. Older online caches can cause
reauthentication when the new adapter reads them; malformed noncanonical records
already rejected by the backend parser remain rejected.

This is persistence evidence, not current authorization. Grants, operation-specific
permissions, fresh owner proof, original online installation-generation fencing,
signed actor context, revocation and merchant staff retention/export remain to
be implemented. A saved `accountOwner: true` alone cannot authorize anything.
Do not fall back to offline API authority after a staff permission denial.

## Verified scope

- 91 focused tests across four suites passed: actual SDK round trips, narrower
  and empty scopes, missing evidence, invalid flags/IDs, duplicate/alias keys,
  offline compatibility, production signed storage-client behavior and backend
  rejection before credential transactions. Some route tests mock service auth;
  those are not evidence of cryptographic verification by themselves.
- 24 isolated MySQL session tests passed across two suites. The new case invokes
  actual signed POST/GET routes, encryption and Prisma persistence, restores the
  narrower scope, rejects malformed owner updates, and verifies offline session
  and integration credential rows remain identical. Existing lease/race and
  lifecycle cases also pass. Synthetic fixtures only; external fetch is forbidden.
- The database target is guarded `127.0.0.1:3307/weletic_loyalty_dev` with the
  expected `loyalty_dev` principal. Cleanup names only generated fixture IDs.
- Independent source review found no blocker; its defensive alias-key suggestion
  was implemented and regression-tested. This is not real Shopify login,
  reinstall/staff authorization acceptance or proof of the complete product.
- Full unit suite: 4,550 passed, six existing skips across 305 files. Root lint
  passed all 10 tasks, final focused lint passed, and Shopify types/build passed.
  The final web compile-mode build and sequential web type-check also passed.
  These totals describe the integration working tree containing this increment;
  a separately extracted PR still requires its own exact-head CI checks.

Full verification logs for this increment use `/tmp/weletic-online-session-*`.
PR #73 independently merged as `8331cd95ff7e504131b4f2cc90a52423e2d69cc3`, and its
post-merge main Fast Quality Gate passed. That CI run does not include this local
session-persistence increment or the other unpublished descendants.
