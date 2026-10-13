# Native review R2 video MVP

This extends the existing native-review domain. It does not introduce a second
review system and it does not activate review rewards.

## Accepted video contract

- Private Cloudflare R2 only.
- One `video/mp4` file per verified-purchase review.
- Maximum 50 MiB and 60 seconds.
- H.264/AVC video, with either no audio or AAC audio.
- Maximum display dimensions of 4096 by 4096.
- A reservation is not attachable to a review until the finalize endpoint has
  checked the R2 object and Mediabunny has validated its container and tracks.
- Storefront URLs are signed for 15 minutes and issued only for media attached
  to a published review. Video bytes never pass through the Next.js or Remix
  request body.

## R2 CORS prerequisite

The private bucket must allow the storefront origins that use the review form:

```json
[
  {
    "AllowedOrigins": ["https://example.myshopify.com", "https://example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Use exact production storefront origins. Do not use `*` for a private review
bucket. `STORAGE_ENDPOINT`, `STORAGE_PRIVATE_BUCKET`,
`STORAGE_ACCESS_KEY_ID`, and `STORAGE_SECRET_ACCESS_KEY` remain the existing
server-only configuration.

## Compatibility invariants

- Historical customer reviews retain `source = verified_customer` by default.
- Customer reviews still require an owned, unexpired purchase request.
- Merchant reviews have no request or shopper relationship, are never marked
  verified, and persist `rewardStatus = ineligible` with
  `rewardReason = merchant_authored`.
- The storefront intentionally shows no merchant badge. It shows the verified
  badge only when `verifiedPurchase` is true.
- Video remains `hasVideo = false` in current loyalty award selection. A future
  activation must update the immutable participation contract and its tests;
  merely uploading a video cannot change points.
- Existing privacy cleanup and shop purge delete both photo and video objects.

## Release order

1. Apply D1 SQLite schema migration `20261014010000_reviews_r2_video`.
2. Deploy application code with video uploads disabled by default.
3. Configure exact R2 CORS origins.
4. Enable video uploads for the test store and validate an upload, moderation,
   storefront click-to-play, privacy deletion, and loyalty non-award.
