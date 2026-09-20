# Public review privacy eligibility — approved design, implementation in progress

The indexed projection was approved in [ADR 0041](../adr/0041-review-privacy-flow-identities-and-execution.md),
merged in public PR #95. The alternatives below preserve decision history;
they are not a new approval request. Shared schema application and release
remain separately gated.

## Evidence and required outcome

The existing review SQL predicate excludes shoppers with linked privacy
tombstones. Customer-ID/email HMAC tombstones can intentionally have no shopper
link: see `upsertShopifyCustomerPrivacyTombstones`. Per-row identity checks catch
those tombstones, but a post-pagination check cannot make SQL totals or page
boundaries accurate. Returning a base64 cursor from a suppressed row would also
expose its ID, rating and timestamp. The pre-ADR draft threw when a scanned row
matched; a match outside that page could still influence totals. The current
unpublished implementation applies the shared SQL predicate before counts and
pagination, including summary-worker reads. See the
[implementation evidence](manual-review-translations-worklog.md). Backfill,
rotation/load proof and live rollout gates remain open.

Required outcome: one privacy eligibility predicate must be applied before
aggregation, sorting and pagination. It must cover linked and unlinked
customer/email tombstones, every retained HMAC key, tenant ownership, privacy
redaction, module availability and publication. No public identity digests,
emails, customer IDs or suppression evidence may be returned.

## Decision recorded

**A — recommended: indexed store-scoped identity projection.** Add a narrowly
scoped private projection of review-owner identities using the existing HMAC
derivation. SQL can anti-join that projection with tombstones before selecting
eligible reviews. Cost: additive schema, writer coverage, backfill and rotation
proof. Benefit: no full owner scan or per-review network query on each request.

**B — per-request identity scan.** Read candidate owners, derive all retained-key
identities, match tombstones and calculate counts/page boundaries from the same
eligible set. This avoids a new persisted projection but has linear application
work and transferred private data on each public request. It needs measured
latency and abuse/load limits; no acceptable performance has been demonstrated.

Option A is approved; end-to-end implementation is not complete. Do not replace
the full goal with permanently unavailable summaries.

## Proposed A contracts and implementation tasks

1. **Projection schema and ownership.** Private rows carry store, source owner,
   identity kind, key ID and existing HMAC digest. Composite tenant relations and
   indexed equality joins are required. Never persist raw email/customer values
   or HMAC secrets. Projection rows are not a new source of authorization.
2. **Coverage/freshness contract.** Specify an auditable coverage marker for
   each projected owner and the required key set. Missing/incomplete/stale
   projections must be distinguishable from an owner with no tombstone. Before
   exposing a store, prove all publishable reviews have current coverage.
   Reader checks must fail closed if that proof becomes invalid.
3. **Writer inventory.** Audit native submission, imports, owner creation,
   customer-ID/email edits, delayed ownership linking, privacy pseudonymization
   and every publication path. Update source and projection atomically under
   existing store/installation/privacy fences. Do not introduce page-render
   writes or an unauthenticated repair endpoint.
4. **Reader.** Reuse a single eligibility predicate for summary count/sum/rating
   distribution and row selection. Pagination is over eligible rows only.
   Keep translation freshness verification and explicit safe output projection.
5. **Key rotation.** Include all retained identity key IDs. Populate new-key
   projections before activating dependent readers; do not retire old keys
   while retained tombstones still require them. Key-set mismatch must be
   observable, not silently interpreted as eligibility.
6. **Privacy/retention.** Erase or retain projection digests only according to
   the existing privacy retention contract; never erase tombstones just to
   restore visibility. Shopper exports must not expose internal HMAC values.
   Purge order, owner conflicts and reinstall behavior need explicit tests.
7. **Migration.** Additive DDL and isolated MySQL rehearsal first. Reader-before-
   writer rollout, idempotent bounded backfill, independent SQL reconciliation
   and an operator-visible readiness check precede activation. Shared/production
   schema application remains separately gated.

## Acceptance examples

- Sole review matches an unlinked customer-ID tombstone: count zero, no average,
  zero distribution, no items and no cursor derived from that review.
- Same outcome for canonicalized email and previous-key tombstones.
- A suppressed row at the start, middle or end of a page cannot create holes,
  duplicate records or leak a suppressed boundary in any sort/rating/locale.
- A tombstone in another store never suppresses this store's review.
- Missing projection, owner-identity change and incomplete key rotation are
  detected; no stale identity is treated as current coverage.
- Concurrent privacy insertion/publication/read, restart during backfill and
  generation changes preserve containment with named isolated SQL evidence.
- UI values and exports reconcile with independent SQL over the same eligible
  population. Widget clears stale content following authoritative unavailability.
- Benchmark representative review volumes and inspect query plans before
  claiming bounded production performance. No latency estimate is yet accepted.

Completion still requires authenticated proxy testing on yamaxdev and the
separate release gates. This proposal authorizes no external mutation or spend.
