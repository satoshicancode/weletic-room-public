-- Read-only. Every finding count must be zero before native reviews release.
SELECT COUNT(*) AS invalid_review_request_ownership
FROM WeleticReviewRequest r
LEFT JOIN WeleticCommerceOrder o ON o.id = r.orderId
LEFT JOIN WeleticShopifyProduct p ON p.id = r.productId
LEFT JOIN WeleticShopper s ON s.id = r.shopperId
WHERE o.id IS NULL OR p.id IS NULL OR s.id IS NULL
   OR o.storeId <> r.storeId OR p.storeId <> r.storeId OR s.storeId <> r.storeId
   OR NOT (o.shopperId <=> r.shopperId);

SELECT COUNT(*) AS invalid_review_line_ownership
FROM WeleticReviewRequestLine l
LEFT JOIN WeleticReviewRequest r ON r.id = l.requestId
LEFT JOIN WeleticCommerceOrderLine ol ON ol.id = l.orderLineId
WHERE r.id IS NULL OR ol.id IS NULL OR ol.orderId <> r.orderId
   OR NOT (ol.productId <=> r.productId) OR l.purchasedQuantity <= 0;

SELECT COUNT(*) AS invalid_review_ownership
FROM WeleticProductReview v
LEFT JOIN WeleticReviewRequest r ON r.id = v.requestId
WHERE r.id IS NULL OR v.storeId <> r.storeId OR v.productId <> r.productId
   OR v.shopperId <> r.shopperId OR v.rating < 1 OR v.rating > 5;

SELECT COUNT(*) AS invalid_review_media_ownership
FROM WeleticReviewMedia m
LEFT JOIN WeleticReviewRequest r ON r.id = m.requestId
LEFT JOIN WeleticProductReview v ON v.id = m.reviewId
WHERE r.id IS NULL OR r.storeId <> m.storeId
   OR (m.reviewId IS NOT NULL AND (v.id IS NULL OR v.storeId <> m.storeId OR v.requestId <> m.requestId))
   OR m.objectKey <> CONCAT('weletic/reviews/', m.storeId, '/', m.id, '.webp')
   OR m.sizeBytes < 1 OR m.contentType <> 'image/webp';

SELECT COUNT(*) AS invalid_review_bearer_state
FROM WeleticReviewRequest
WHERE (tokenHash IS NOT NULL AND (CHAR_LENGTH(tokenHash) <> 64 OR status NOT IN ('sending', 'sent', 'failed')))
   OR (encryptedDeliveryToken IS NOT NULL AND status NOT IN ('sending', 'failed'))
   OR (deliveryToken IS NOT NULL AND (status <> 'sending' OR deliveryLeaseExpiresAt IS NULL OR deliveryReservedAt IS NULL))
   OR deliveryAttempts < 0 OR expiresAt <= sendAt;

SELECT COUNT(*) AS redacted_review_content_retained
FROM WeleticProductReview
WHERE status = 'redacted' AND (body <> '' OR title <> '' OR merchantReply IS NOT NULL OR moderatedByUserId IS NOT NULL);

SELECT COUNT(*) AS missing_review_reward_evidence
FROM WeleticProductReview v
LEFT JOIN WeleticPointsLedgerEntry l ON l.id = v.rewardLedgerId
WHERE v.rewardStatus IN ('awarded', 'reversed') AND (l.id IS NULL OR l.storeId <> v.storeId OR l.referenceId <> v.id OR l.referenceType <> 'REVIEW_NATIVE');
