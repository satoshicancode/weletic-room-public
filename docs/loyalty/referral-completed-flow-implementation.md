# Referral-completed Flow implementation

Implementation branch: `codex/loyalty-referral-completed-flow` in the public
repository. Not deployed or accepted on `yamaxdev`; release gates below remain.

## Scope and contract

Add `weletic-referral-completed` through the existing `FLOW_TRIGGER` outbox;
no database schema change. Existing four trigger handles remain unchanged.
The customer reference identifies the advocate. Custom fields are Referral id,
Order id, Advocate points and Friend points. Points retain exact integer text;
the payload does not include the friend's customer ID, email, or email digest.
The referral ID plus trigger handle is the producer idempotency key. This does
not guarantee exactly-once delivery across ambiguous Shopify network responses.

Completion means rewards have been fulfilled, not merely order qualification:

- Account-based points-only referrals enqueue in the award transaction.
- Coupon referrals enqueue with the successful qualified-to-rewarded CAS after
  every required coupon has reached an accepted fulfillment status.
- Preissued friend-coupon referrals with a points advocate enqueue in their
  separate qualification/award transaction. Coupon advocate variants use the
  shared coupon finalization path.

The existing maintenance and installation-generation outbox fences remain.
Coupon bookkeeping must remain possible under its existing lock-only program
mode, including after the program has been disabled.

## Open review findings and release gates

- Anonymous friends now require the approved scoped privacy snapshot. Legacy,
  erased, expired or unverifiable snapshots fail closed; they are not backfilled
  from the incompatible referral-email digest.
- Completion is now revalidated after credential refresh, including a second
  failed-lookup test. Prove remaining friend privacy closure and refund races:
  the current outbox customer lock covers the advocate only, and the recheck is
  not a lock extending through the remote Shopify request.
- Extend producer tests for every completion path, duplicate completion, failed
  outbox persistence and still-pending coupon fulfillment.
- The local extension manifest is added and schema-validated. Generate its UID
  against the reviewed public registration and verify ownership before deployment.
  Do not copy an extension UID from the old custom app or invent a public UID.
- Public CI and PR review remain required before merge. Live Flow workflow
  execution requires approved Shopify deployment.

Initial focused checks: 76 tests across contracts/referrals/coupons passed, then
18 worker tests passed after correcting a BigInt test-name formatting error.
These historical results predate the integration evidence below. The first web
typecheck exhausted Node's default heap; an 8 GiB retry passed. None of these
checks establish live Flow acceptance.

Reference: [Shopify Flow trigger creation](https://shopify.dev/docs/apps/build/flow/triggers/create).
Shopify requires the GraphQL payload keys to match the extension's declared
fields and a payload smaller than 50 KB. The existing payload normalizer retains
that byte bound. Public identity selection and deployment remain separate gates.

## Anonymous friend privacy identity decision

The friend-claim qualification contract permits both `refereeAccountId` and
`refereeShopperId` to be absent. The remaining `friendEmailDigest` is generated
with the `referral_email` derived-signal purpose; it cannot be compared to an
email identity tombstone, which uses a different HMAC context. Neither hash can
be reversed to reconstruct the canonical email. Assuming an account exists, or
simply permitting missing accounts, does not cover this supported journey.

Accepted by Hiro on 2026-09-09 ([ADR 0022](../adr/0022-anonymous-referral-privacy-snapshot.md)): retain a versioned HMAC-only
customer-privacy identity snapshot in existing referral metadata when the raw
friend email is transiently available. Do not retain raw email or include the
snapshot in the Shopify Flow payload. This needs explicit privacy erasure,
retention and key-retirement integration, not just a dispatch-reader change.
Legacy rows without a verifiable identity need an explicit recovery/eligibility
policy; do not fabricate identity evidence from the referral-email digest.

The post-refresh change passes all 20 worker unit tests. These simulated
interleavings are not real MySQL/Shopify race acceptance.

## Producer assertions

The three producer suites pass 83 tests after adding explicit completion-event
assertions. The account-referral fixture is now explicitly points-only on both
sides: its former default had a referee coupon and correctly did not complete
in the qualification transaction. The coupon qualification test separately
asserts no completion event while rewards remain pending. The friend-claim test
asserts one event with the exact advocate identity and point totals. Coupon
bookkeeping tests assert no emission when a required coupon is outstanding or
the qualified-to-rewarded compare-and-set loses its claim.

These call the actual producer functions with mocked persistence; they do not
prove database rollback on outbox failure or concurrent remote delivery. Those
gates remain open. The anonymous privacy-identity design is now approved;
implementation and verification remain unfinished.

## Approved identity contract implementation

The initial standalone snapshot writer and reader are implemented with eleven
passing focused tests. The writer verifies the transient email against the
referral's existing store-scoped digest, then records versioned, tombstone-
compatible email HMAC identities for all configured keys. Scope includes store,
referral and the existing friend digest. No raw email is retained. Versioned
identity strings are compatible with the existing recursive key-retirement audit.

Retention is bounded by the shorter configured financial and customer-tombstone
period, recomputed on reads so a shortened policy or overlong stored expiry
cannot extend eligibility. The reader rejects expired/future, malformed, wrong-scope, missing,
duplicate-key and retired-key evidence. This reader only invalidates use;
physical erasure and retirement integration are described below.
The initial standalone-helper status above is superseded by the integration
evidence below; live anonymous-friend support is still not claimed.

## Producer, dispatch and privacy integration

Qualification captures the snapshot in the same transaction as the award, from
the canonical email and matching persisted friend digest. Dispatch checks scope,
expiry, keys, redaction metadata and owner/email tombstones both before and after
credential resolution. Anonymous points and coupon completions are covered. The
Shopify payload contains neither the snapshot nor friend identity.

The four focused suites passed 66 tests: snapshot contracts, Flow worker,
friend-claim qualification/erasure and key-retirement audit. Both existing friend
erasure paths replace metadata and remove the snapshot; the real retirement
scanner detects its previous-key dependency until erasure. Web typecheck and
focused lint passed for this integration.

Physical expiry pruning now runs in the existing privacy retention tick before
tombstone cleanup. A parameterized atomic JSON_REMOVE preserves other metadata,
uses both the stored deadline and the current shorter retention policy, and caps
writes at 100 per tick. It deliberately covers inactive/uninstalled stores.
Canonical UTC ISO timestamps come from the trusted snapshot writer. Cleanup also
removes non-object snapshots, missing/null/noncanonical dates, future captures
and reversed deadlines. It checks timestamp shape, not complete calendar
validity; capture age/future bounds still prevent indefinite retention.

Current focused verification passes 212 tests across nine suites, plus fourteen
real MySQL predicate tests in
`shopify-referral-retention-db.integration.test.ts`, using the dedicated
`vitest.referral-retention-db.config.ts`. The database suite requires
`REFERRAL_RETENTION_READONLY_DATABASE_INTEGRATION=1` and the exact isolated URL
and database principal. It captures the production query, then evaluates its
parameterized predicate using SELECT over inline JSON. It writes no records,
requires no fixture cleanup, and performs no external Shopify calls.

These tests prove selection semantics, not actual UPDATE concurrency. A read-only
EXPLAIN of the actual UPDATE on isolated MySQL succeeded and reports a PRIMARY
index scan with `Using where; Using temporary`. Its one-row estimate is not
production-scale evidence. Concurrent-update and representative-load verification
remain open: LIMIT bounds writes, not the JSON scan cost.

Latest web typecheck passed with an 8 GiB heap. Focused lint, Prettier, Prisma
validation, Shopify app typecheck/build, and the web production build passed.
The broader Weletic regression run passed 333 files: 5,129 passed and six skipped
tests. The manifest contract suite was rerun separately after the manifest edit.
These are local results; no deployment or live acceptance is claimed.

## Extension manifest validation and ownership fence

`shopify app config validate --json` returned `valid: true`, `issues: []` with
the new referral manifest included. It used the unchanged default custom-app
configuration, so it proves schema validity, not public-app ownership. The CLI
also auto-inserted a local UID; review caught this and the unverified UID was
removed. Do not assume config validation is filesystem-read-only.

The manifest stays UID-free until reviewed public registration selection and
ownership evidence are available. A temporary contract assertion rejects any
UID insertion; update it only with that evidence. A second assertion compares
all declared custom fields with the actual normalized GraphQL payload. No
app linking, deployment, installation or remote configuration command was run.
Toolkit/CLI telemetry was disabled for the local command.
