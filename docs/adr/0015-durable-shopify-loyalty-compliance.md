# ADR 0015: Durable Shopify loyalty compliance

- Date: 2026-08-30
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Weletic Loyalty serves in-house brands on Shopify Basic and provisions native
Shopify discount codes as loyalty vouchers. The existing hardening pass made
redemption, referral, settlement, webhook authentication, and tenant isolation
fail closed, but the compliance lifecycle still depended on live Shopify Admin
API credentials and synchronous request work.

That dependency is unsafe for `app/uninstalled` and `shop/redact`: Shopify may
revoke the offline token before a later compliance webhook arrives. A resolver
that requires the token can acknowledge the signed webhook without recording or
executing erasure. Similarly, `customers/redact` arriving before a shopper is
created has no independent tombstone, so a delayed customer or order webhook can
recreate personal data and award points. `customers/data_request` also relied on
best-effort asynchronous notification after the webhook was marked processed,
without durable export progress or retry state.

The loyalty data plane also contains customer-linked records outside the points
ledger: earn grants, order-line earn allocations, and import/backfill previews.
Leaving those models outside the compliance workflow would make an access export
incomplete and could leave customer-derived snapshots after redaction. At shop
erasure, deleting every loyalty definition is not safe either: historical tier,
redemption, grant, and ledger rows retain foreign keys to program, tier, and
reward definitions for financial audit integrity.

Installation timestamps are an unsafe authority boundary. Credential
verification legitimately updates bookkeeping fields after installation, and a
delayed uninstall can arrive after a newer reconnect. Using
`InstalledIntegration.updatedAt`, `shopVerifiedAt`, webhook receipt time, or
another mutable timestamp to decide which installation owns a store creates a
race in which an old uninstall can erase the current installation or a
post-cutoff verification update can escape credential scrubbing.

Unused Shopify vouchers add a second boundary. Redacting a local customer does
not itself deactivate a code already issued in Shopify, and uninstalling before
reconciliation can discard the only usable token authority. Finally, settlement
now detects duplicate discount codes in application code, but the database does
not prevent another duplicate from being created later.

The rollout is currently limited to in-house stores, but compliance correctness
must not depend on low volume. Used-voucher and financial records may need lawful
retention, while operational configuration, direct identifiers, unused vouchers,
and export artifacts require explicit deletion or expiry behavior.

## Decision

Weletic will introduce a durable Shopify compliance plane. Signed compliance
webhooks will resolve the tenant by the exact canonical
`WeleticShopifyStore.shopDomain` mapping without requiring a live access token,
persist an idempotent compliance request before acknowledgement, and process
shop erasure, customer erasure, and customer export through bounded, retryable,
audited phases. Customer privacy tombstones will exist independently of shopper
rows and will use a versioned keyed-HMAC identity derived from a dedicated
deployment secret; raw Shopify customer identifiers will not be the durable
anti-resurrection key.

Customer access exports will page customer-owned loyalty data into encrypted
artifacts in deterministic batches of at most 100 records. The ordered export
includes earn grants, their order-line earn allocations, and backfill preview
items in addition to identity, ledger, redemption, tier, referral, and order
records. Customer redaction will process at most 20 rows per step: delete linked
backfill previews and remove customer-derived fields from earn-grant calculation
snapshots/metadata and order-line earn metadata. Redaction preserves the
relational and financial foreign keys required to keep retained accounting rows
internally consistent.

Customer redaction will enqueue cleanup for every unused or ambiguously
provisioned voucher. Cleanup must verify immutable Shopify ownership, deactivate
the remote discount, and only then apply privacy-safe local
cancellation/compensation. Used vouchers retain pseudonymized financial audit
state. Uninstall follows freeze, reconciliation/deactivation while authority is
available, durable recording of unresolved cleanup, cache invalidation, and
credential/session scrubbing. Shop redaction deletes operational configuration
and personal data while pseudonymizing only records covered by the configured
financial-retention policy.

Shop redaction will first scrub customer-derived fields from retained earn-grant
and order-line-earn snapshots, drain backfill previews before deleting their
jobs, delete operational earning rules, bonus campaigns, and referral rules,
then neutralize rather than delete retained tier, reward, and program rows.
Neutralization removes branding, names, descriptions, remote Shopify rule
identifiers, targeting configuration, and metadata; archives rewards; and leaves
the program disabled with its kill switch active. This ordering removes
customer-facing and executable configuration without breaking historical
financial foreign keys.

Every accepted Shopify connection will create a dedicated immutable
`installationGeneration`. The same value is committed on
`WeleticShopifyStore.installationGeneration` and inside the installed
integration credential document. Credential verification must prove the
canonical domain and token, then re-check and publish its verification evidence
under the locked store row for that exact generation. Mutable timestamps,
including `InstalledIntegration.updatedAt`, are observations only and never
installation authority. Within one installation generation, the SHA-256 digest
of the decrypted access token is the optimistic credential version: callback
and signed session refresh writers snapshot that exact version and compare it
again while holding the store row before replacing the credential. A concurrent
late writer loses even when the installation generation is unchanged. Raw
credential-bearing resolver results are never process-cached; every local
consumer re-reads and validates the current installed-integration row, while the
standalone Shopify app remains the production refresh authority.
`app/uninstalled` persistence captures the locked
generation inside the encrypted compliance request subject. Freeze, uninstall
cleanup, and credential erasure compare that captured value with the current
store and credential generation; a delayed request for an older generation
terminates as `stale_after_reinstall`. The shared row lock serializes verification
bookkeeping with lifecycle freeze/scrub so a post-cutoff verification write
cannot escape cleanup.

Reward redemptions will gain a canonical discount-code identity with a database
unique constraint scoped to the Shopify store. The migration will first backfill
canonical values and quarantine any collision; the unique constraint is added
only after the collision audit is clean. The HMAC secret is versioned so rotation
can introduce a new writer key without invalidating existing identities. A
previous key is not eligible for retirement merely because its tombstones have
expired: retirement is blocked while any persisted pseudonym, voucher-selection
snapshot, referral digest, or other derived privacy signal still names or
requires that key. The release gate must prove every dependency has either
expired under a bounded retention policy, been re-keyed, or been irreversibly
deleted through an audited migration. A referral or privacy signal with no
verified expiry is therefore an unbounded dependency and keeps the key active.

## Alternatives considered

- **Keep synchronous webhook processing and Plain delivery** — Rejected because
  a successful webhook acknowledgement could outlive failed erasure or export
  delivery, with no durable retry point.
- **Resolve compliance webhooks through the normal Shopify token authority** —
  Rejected because uninstall and token revocation can precede `shop/redact`.
- **Keep issued vouchers active until expiry or manual cleanup** — Rejected
  because unused and non-expiring codes can remain usable after customer
  deletion or app uninstall.
- **Rely only on application-level duplicate detection** — Rejected because it
  cannot prevent concurrent or future writers from violating settlement
  cardinality.
- **Retain raw Shopify customer IDs as permanent tombstones** — Rejected because
  keyed, versioned pseudonymous identities provide the required replay boundary
  with less retained personal data.
- **Hard-delete every ledger and voucher record** — Rejected because completed
  financial activity may require a lawful, auditable retention period; those
  rows will instead be minimized and pseudonymized.
- **Hard-delete programs, tiers, and rewards during shop erasure** — Rejected
  because retained redemptions, grants, tier history, and ledger evidence need
  stable foreign-key targets; operational fields can be neutralized instead.
- **Use integration or webhook timestamps as installation authority** — Rejected
  because verification bookkeeping is mutable and may occur after an uninstall
  cutoff. An explicit immutable generation gives retries and reconnects an exact
  ownership boundary.

## Consequences

### Positive

- Compliance processing survives token revocation, worker failure, retries, and
  webhook reordering.
- Redact-first requests prevent later customer or order events from recreating
  the loyalty member or awarding points.
- Customer exports and erasure have observable progress, bounded work, retry,
  failure, and retention state.
- Access exports include earn grants, order-line earns, and backfill previews;
  customer erasure removes or scrubs the same data classes in bounded phases.
- Shop erasure removes executable loyalty configuration without invalidating
  retained financial foreign keys.
- A delayed uninstall cannot erase credentials from a newer installation
  generation, and credential verification cannot publish outside the lifecycle
  lock.
- Unused remote vouchers cannot silently outlive customer deletion or uninstall.
- Settlement cardinality is enforced by the database as well as application
  checks.
- Customer anti-resurrection identities can be rotated and expired without
  retaining the raw Shopify identifier indefinitely.

### Negative / trade-offs accepted

- The change requires new Prisma models/fields, a staged backfill, and a new
  versioned HMAC deployment secret.
- Compliance workers and remote voucher cleanup introduce more states and
  operator-visible dead-letter cases.
- Retaining neutralized program, tier, reward, grant, and order-line rows consumes
  storage until the configured financial-retention gate allows hard deletion.
- Missing or mismatched installation-generation evidence fails closed and may
  require an operator-assisted reconnect rather than timestamp-based recovery.
- Previous HMAC keys must remain available until both their tombstones have
  expired and an audited dependency scan proves that no persisted pseudonym or
  bounded/unbounded referral, voucher-selection, or privacy signal still
  depends on the key. Tombstone expiry alone is never a retirement condition.
- Financial retention duration is configuration and policy, not a hard-coded
  legal conclusion; production activation remains blocked until it is set.
- A migration involving shared infrastructure cannot be auto-merged or applied
  without the repository's explicit migration release gate.

### Follow-ups

- Add durable compliance request, privacy tombstone, export artifact/chunk, and
  voucher-cleanup state to the Prisma schema.
- Add a token-independent exact-domain compliance resolver and invalidate the
  domain cache during uninstall and shop erasure.
- Implement bounded cursor workers for customer export/redaction and shop
  erasure, with idempotent phase transitions and audited retries.
- Backfill/quarantine canonical voucher codes before adding store-scoped
  uniqueness.
- Document the HMAC keyring format, rotation procedure, dependency-scan and
  re-key/delete release gate, artifact expiry, and financial-retention
  configuration.
- Add revoked-token, redact-first, export-delivery-failure, live-voucher,
  uninstall, duplicate-code-migration, and long-running worker tests.

## References

- Hiro approval of Option A for all three decisions in the Weletic Loyalty
  discussion on 2026-08-30.
- https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
- https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
- https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5930.htm
- `apps/web/app/(ee)/api/shopify/integration/webhook/route.ts`
- `apps/web/lib/weletic/shopify/store-resolver.ts`
- `apps/web/lib/weletic/loyalty/shopper-privacy.ts`
- `apps/web/lib/weletic/loyalty/redemption-settlement.ts`
- `apps/web/prisma/schema/weletic-commerce.prisma`
- `apps/web/prisma/schema/weletic-loyalty.prisma`
- `/Users/hironguyen/.codex/memories/project_adr_0015.md`
