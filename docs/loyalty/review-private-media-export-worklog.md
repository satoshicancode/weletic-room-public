# Private review media export completion

## Scope and rollout

Follow-up to [PR #98](https://github.com/satoshicancode/weletic-room-public/pull/98),
merged as `dcde31d603426e09529de3339e182e8db4c6cc35` after all six pre-merge
checks passed. Deliver invitation and open-review photos through the
existing encrypted customer compliance export, without direct R2 bearer URLs.
No new public API or schema. Shared deployment and live sends remain gated.

PR #98 post-merge workflow `35515182465` also passed all six checks. Local main
was fast-forwarded without changing the pre-existing acceptance-matrix edits;
only the merged open-submissions branch was removed. This follow-up is prepared
on `codex/review-private-media-exports`; GitHub checks and merge are tracked
separately from the local evidence below.

Affected subsystems: private storage, review ownership, compliance pagination,
encrypted artifact publication/download, privacy retention and regression tests.
Use one photo (maximum 2 MiB) per encrypted chunk; authorize ownership before and
after storage I/O, and recheck export revocation immediately before releasing
decrypted plaintext. Preserve financial records and invitation authority.

## September 20 implementation checkpoint

- Added direct signed, uncached R2 GET with no redirects/retries, exact declared
  size/type checks, streaming size enforcement and cancellation.
- Replaced the worker's direct invitation-photo URLs with bounded encrypted file
  content; extended selection to confirmed open uploads. Unattached uploads use
  exclusive source ownership, not the more permissive privacy-erasure predicate.
- Added complete attached ownership validation using the existing source-aware
  photo checker, same-store product checks for every attachment/reservation, and
  immutable snapshot comparison after I/O.
- Added a final download-stream revocation check after remote retrieval. A
  regression proves revocation during retrieval withholds the private payload.
- Expanded focused verification passed 166 tests across five files, including
  ownership-corruption, snapshot-change, stale-lease, bounded-checkpoint-read and
  crash-recovery regressions. Non-incremental TypeScript passed before the latest
  checkpoint changes; the final non-incremental TypeScript and changed-file ESLint
  run passed after adding both SQL tests.

## Crash-recovery correction identified by independent review

Artifact publication and cursor checkpoint are separate. A crash after publishing
photo A but before saving its cursor can select B on retry if A leaves the live
selection. Reusing immutable artifact A while advancing the cursor past B silently
omits B. Replay now resumes from the authoritative artifact's exact stored file
identity/cursor, including an ambiguous publication winner. The regression
commits A then loses the acknowledgement, changes the live page to B/C, recovers
A without reading B as sequence zero, then exports B at sequence one.

The versioned file-chunk checkpoint is inside its existing encrypted artifact;
read it under the current request lease and privacy fence before selecting or
publishing another page. Resolve the immutable winner after publication. Use
keyset continuation so deletion of A cannot invalidate its cursor. No raw file
keys or customer identities enter cursors. Independent review confirmed this
correction and identified one further attached-product tenancy check, now applied
to both invitation and open attachments with foreign-product regressions.

Disposable SQL fixture `weletic_loyalty_it_shopper_c7d302f53422` failed at new
test fixture creation because its required title was omitted; exact cleanup
completed and the retained ledger stayed 16 → 16. Corrected fixture
`weletic_loyalty_it_shopper_4582f60cb23a` passed the new real-SQL ownership,
attached-source corruption and mid-read erasure test (one selected test, 90
intentionally filtered), followed by all 154 shopper SQL tests. Exact fixture/user
cleanup completed; retained ledger stayed 16 → 16. Storage is mocked; no provider
acceptance is claimed.

Fresh full SQL fixture `weletic_loyalty_it_shopper_03d7c1a8c197` passed all 92
native-review and 154 shopper tests. Its new checkpoint case uses actual
SQL artifact publication and encryption with in-memory storage: intentionally
lose the worker cursor, delete photo A, recover the immutable A cursor, then
export B without a missing/duplicate artifact. It also rejects the stale lease.
This simulates a lost checkpoint; it does not kill the worker process.
Exact database/account cleanup completed; the retained ledger stayed 16 → 16.
MySQL and its SSH forward were stopped afterward. Final independent review
confirmed both ownership and checkpoint corrections with no remaining blocker
in the reviewed code boundaries.

Full web regression passed: 610 files, 9,868 tests passed and six skipped
(650.95 seconds; started September 20 at 23:14 JST). The fresh isolated Linux
image build and no-network web runtime smoke both passed. Image identity:
`sha256:c52258b6f7cd3e3cb2885785207f39ae5621f30dde52f0f099eb187998251277`.
The smoke checks production startup admission, route isolation and authentication
rejection with synthetic configuration; it does not prove live review routes,
R2 retrieval or installed-store behavior. Covered cases include ownership/source corruption;
foreign product; privacy changes
during GET and download; excessive/truncated bytes; one-photo lookahead; crash
after publication; changed live selection; stale lease; provider/read ambiguity;
exact resumed artifact contents and cursors. Rehearse against isolated SQL and
mocked storage before real R2 and authenticated export acceptance.

Historical artifacts may already contain direct links. Do not claim retroactive
revocation; deployment must inventory active artifacts, contain affected exports
and let existing signed-link validity expire before closing this release gate.

## Legacy-checkpoint deployment gate

The former `review_media` chunk format is an array containing direct storage
links. New chunks are versioned `review_media_files_v1` objects containing bounded
file bytes and their exact continuation. New workers reject old/malformed
checkpoints; they must not overwrite an old immutable sequence or guess its
cursor. This is an explicit operational gate, not a shared migration applied by
this PR.

Before a separately approved environment rollout:

1. Pause affected export scheduling and delivery using the environment's worker
   controls. Keep required privacy intake available. Inventory the exact store's
   nondeleted `review_media` artifacts and their requests, including processing,
   retrying, dead-letter and completed requests. Use read-only scoped SQL below;
   never export ciphertext, object keys, download tokens or customer identities.
2. In a private operator session classify the encrypted chunk format through the
   authenticated existing export tooling. A metadata-only inventory cannot prove
   a chunk is the new format. If old in-flight chunks exist, keep those requests
   contained for audited recovery; do not automatically reset their cursor or
   reuse a sequence. The operator restart/supersession procedure is not implemented
   in this slice and must be completed before resuming such a request.
3. Record the last legacy writer's stop time and the latest possible old-link
   expiry. The old code capped validity at seven days; already delivered direct
   links cannot be retroactively revoked merely by revoking the outer export.
   Wait for their validity to lapse, or execute a separately approved provider
   containment operation. Do not delete original review photos as a shortcut.
4. Resume only new-format requests after current-lease retry, private download,
   redaction races and provider retrieval are accepted in the target environment.
   Retain the audit of old requests and exact cleanup/recovery disposition.

```sql
-- Bind an explicitly approved store ID; read-only metadata, private operator use.
SELECT a.id, a.requestId, a.sequence, a.createdAt, a.expiresAt,
       r.status, r.phase
FROM WeleticShopifyComplianceArtifact a
JOIN WeleticShopifyComplianceRequest r ON r.id = a.requestId
  AND r.storeId = a.storeId
WHERE a.storeId = ? AND a.kind = 'review_media' AND a.deletedAt IS NULL
ORDER BY a.createdAt, a.id;
```

No live inventory, containment, notification, production rollout or expiry claim
is supplied by the local tests above.
