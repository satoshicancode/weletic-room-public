# ADR 0019: Native review R2 video MVP

- Date: 2026-09-08
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Weletic Room needs a shippable product-review MVP while loyalty remains the
primary development priority. The repository already contains an unfinished
native review domain with verified-purchase requests, moderation, privacy
cleanup, Shopify summary synchronization, and loyalty incentive controls. A
second review implementation would duplicate these boundaries and make the
eventual review/loyalty integration harder to reconcile.

Reviews need optional photos and short videos. Cloudflare Stream would provide
managed transcoding and adaptive delivery, but its recurring video-delivery
cost is not justified for an MVP whose playback is a user-initiated review
attachment. Private Cloudflare R2 keeps storage and delivery inexpensive, but
requires a deliberately narrow upload contract and server-side container and
codec validation.

The store owner must also be able to author a review from Shopify Admin. Such a
review has no verified purchase or shopper identity, so presenting it as a
customer or connecting it to loyalty evidence would be misleading. Hiro chose
to show no special public badge for these reviews.

## Decision

Extend the existing native review models and services rather than create a
parallel clone. Verified purchasers continue to submit through owned review
request tokens. Store-owner reviews use `source = merchant`, have no request or
shopper relation, are never verified or reward-eligible, and show no public
merchant badge. The source remains visible internally for moderation and
auditing.

Store at most one short review video per verified-purchase review in private
Cloudflare R2. The browser uploads directly with a signed PUT; the server then
checks the object and validates an MP4 containing one H.264/AVC video track and
at most one AAC audio track using pinned Mediabunny `1.55.7`. The limits are 50
MiB, 60 seconds, and 4096 by 4096 display pixels. Playback URLs are short-lived
and fetched only after the shopper clicks play. Video does not activate or
alter loyalty rewards.

## Alternatives considered

- **Cloudflare Stream** — Managed transcoding and playback. Rejected for the MVP
  because its video pricing is excessive for short, click-to-play review media.
- **A separate minimal review clone** — Faster in isolation. Rejected because it
  would duplicate the unfinished native review, privacy, moderation, summary,
  and loyalty boundaries.
- **Public merchant-authored badge** — Explicitly label owner-created reviews.
  Rejected because Hiro selected a neutral storefront presentation; internal
  provenance and the absence of a verified badge still prevent false purchase
  attribution.

## Consequences

### Positive

- Review MVP work remains compatible with unfinished review and loyalty code.
- Video bytes bypass application servers and use R2's low-cost object delivery.
- Merchant reviews cannot create, retry, reverse, or otherwise mutate loyalty
  rewards.
- Public review cards stay visually simple while verified-purchase provenance
  remains explicit.

### Negative / trade-offs accepted

- R2 does not transcode; uploads outside the accepted MP4/H.264/AAC contract are
  rejected.
- There is no adaptive bitrate ladder or generated poster in this MVP.
- Every storefront origin needs exact private-bucket CORS configuration.
- The schema migration and feature activation require a staged rollout.

### Follow-ups

- Apply the additive migration only after explicit shared-infrastructure
  approval, then run its read-only gate before enabling video.
- Configure exact R2 CORS origins and manually smoke-test upload, moderation,
  click-to-play, privacy deletion, and loyalty non-award on the test store.
- Any future loyalty video bonus requires a separate ADR and versioned incentive
  contract; the presence of video alone remains insufficient.

## References

- `docs/reviews/r2-video-mvp.md`
- Implementation branch: `codex/reviews-r2-video-mvp`
- Approval: Hiro's 2026-09-08 review MVP discussion and “Option B: Show no
  badge” decision
