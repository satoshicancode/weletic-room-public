# Anonymous referral confirmation milestone — September 17, 2026

Scope: the requested coupon confirmation selected in
[ADR 0035](../adr/0035-anonymous-referral-confirmation-retention.md).
This is separate from account-backed marketing journeys. No account or marketing
consent is invented for an anonymous friend. No live delivery or rollout gate is
closed by this document.

## Implemented lifecycle

1. A new eligible coupon claim captures original installation generation,
   store/program/referral ownership, recipient HMAC, reward snapshot digest,
   coupon identity, EN/JA/VI locale and privacy lookup evidence. Existing claims
   without this provenance cannot acquire new email authority.
2. The same signed claim gateway accepts an optional validated locale. The
   storefront supplies its normalized language; omitted locale defaults to EN.
   Fixed service-confirmation copy replaces the old invitation wording and never
   includes the advocate's private name. Merchant branding is frozen at first
   preparation; economic facts come from the locked reward snapshot.
3. Before provider I/O, a transaction commits an AES-GCM-encrypted envelope with
   the exact normalized recipient/from/reply-to/subject/HTML/headers, original
   binding, remote discount identity, provider key and immutable retry deadline.
   Authenticated inner and outer bindings must match. A valid ciphertext from
   another claim and a rewritten outer deadline are rejected.
4. Dispatch reacquires store → program → referral locks and checks generation,
   active admission/program, current voucher, reward expiry, recipient/privacy
   evidence, account erasure, merchant pause and lease owner. The provider call
   has an eight-second local wait bound inside a fifteen-second transaction.
   Only one valid Resend acknowledgment finalizes delivery. No SMTP fallback.
5. A retry through the existing claim flow reuses exactly the saved request and
   provider key; it never rerenders or generates a new key. Transport timeout or
   local rollback after provider acknowledgment is ambiguous, not proof that no
   email was sent. A timed-out HTTP request may still complete at the provider;
   the local timeout does not promise cancellation.
6. Confirmed delivery physically removes ciphertext. Customer/shop erasure
   invalidates leases and removes payloads; both account scrub paths lock and
   reread current referral metadata. Atomic cleanup cannot release a newer
   worker's lease or resurrect erased metadata.
7. The existing privacy retention sweep now purges expired/malformed retained
   payloads in bounded batches, including inactive/frozen stores. Original
   preparation age caps retention at 23 hours. A terminal marker prevents
   regeneration after purge. Bounded writes do not guarantee bounded scan cost;
   deployment must measure the query and supervise the sweep.

## Verification and migration of tests

The old arbitrary-callback sender and its obsolete SMTP-success/lease tests are
removed. Their applicable guarantees are tested against the replacement, rather
than counting tests of unreachable code as acceptance.

- Unit contracts: exact retry bytes, malformed and missing provenance,
  recipient/generation/reward/privacy changes, expired reward and retry window,
  concurrent-owner cleanup, complete provider acknowledgment, timeout,
  authenticated-envelope transplantation and rewritten timestamps.
- Integration seam: a successful new Japanese claim invokes actual email
  rendering and normalization, then the new sender with a mocked provider.
- Real MySQL, mocked provider: duplicate dispatch bursts, pause/resume, ambiguous
  retries, provider acknowledgment followed by SQL rollback, stale-owner cleanup,
  erasure before/while sending, reinstall/program/account changes, expiry after a
  lock wait, cross-tenant state isolation, and physical retention purge.
- Disposable schema: `127.0.0.1:3307/weletic_loyalty_it_anonymous_20260917_a`.
  This is not `weletic_loyalty_dev`, legacy, production or a Shopify store.
  Independent SQL audits inspect all 157 fixture tables after cleanup.

Final-source local evidence includes 134 focused tests across ten files, 16
anonymous-confirmation MySQL cases and four existing outbox concurrency cases.
The final SQL audit found all 157 fixture tables empty. Provider transport was
mocked throughout. Type-checks, lint, formatting and Prisma validation passed;
full-suite/build results and publication status are recorded in the implementing
PR. Earlier passing checkpoints are not evidence for later unverified changes.

The new database suite runs with
`pnpm --filter web exec vitest run --config vitest.anonymous-confirmation-db.config.ts`.
It requires `LOYALTY_DATABASE_INTEGRATION=1` and an independently provisioned,
fresh disposable database matching its strict loopback/name/user guard. Never
substitute a shared database. Local unit runs require the same dummy Shopify app
identity as CI; missing `SHOPIFY_API_KEY` reproduces `invalid_scope` on unchanged
public main and must not be worked around by weakening session authorization.

## Remaining release gates and runbook

- Configure an explicitly approved sender, Resend and encryption/privacy keys in
  the isolated public-app runtime. Missing capability fails closed.
- Deploy and supervise the existing retention scheduler; verify its cadence,
  lag alerts, bounded batch throughput and physical deletion. The new sweep is
  code integration, not an already-running service.
- Retry is currently initiated through the existing claim flow. This milestone
  does not introduce a separate anonymous-email scheduler or a new public resend
  API. After 23 hours, do not clear attempts/terminal markers or issue a fresh
  provider key. Reconcile the original key with the provider under explicit
  operator authorization; never recover ciphertext from backups to resend.
- To pause dispatch, use the merchant email pause or program kill switch.
  Already-admitted provider calls may finish; privacy erasure cannot recall mail.
  Retention/privacy cleanup continues independently of loyalty activation.
- Prove actual EN/JA/VI inbox output, fresh authentication, owned Shopify coupon
  use, install/reinstall containment, privacy webhooks and scheduling on yamaxdev
  under their separate execution gates. No real email/order/deployment occurred
  during local verification. Production weletic.com remains separate.
- Editable anonymous marketing, invitations, quiet-hour/frequency policy and
  broader referral-funnel analytics are not implied by this confirmation path.
  Existing account-backed consent and delivery rules remain unchanged.
