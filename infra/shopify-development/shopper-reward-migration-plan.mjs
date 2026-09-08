/** Compare only the reviewed expansion statements. Prisma can emit independent
 * table/index operations in a different order for a complete versus staged diff.
 * Missing, duplicate, extra or altered statements always require inspection.
 */
export function planShopperRewardExpansion(actual, reviewedSql) {
  const statements = (sql) =>
    sql
      .replace(/^--.*$/gm, "")
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean);
  const pending = statements(actual);
  if (pending.length === 0) return [];
  const expected = reviewedSql.flatMap(statements);
  // A fresh claims table emits this exact index inline; an already-expanded
  // table emits the separate operation. Normalize only this reviewed index for
  // comparison, still executing the reviewed table-before-index phase order.
  const comparable = (items) =>
    items
      .flatMap((sql) => {
        const declaration =
          "    UNIQUE INDEX `wl_review_claim_store_id_uq`(`storeId`, `id`),\n";
        return sql.startsWith("CREATE TABLE `WeleticReviewIncentiveClaim` (") &&
          sql.includes(declaration)
          ? [
              sql.replace(declaration, ""),
              "CREATE UNIQUE INDEX `wl_review_claim_store_id_uq` ON `WeleticReviewIncentiveClaim`(`storeId`, `id`)",
            ]
          : [sql];
      })
      .sort();
  if (
    expected.length === 0 ||
    expected.some(
      (sql) =>
        /\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME)\b/i.test(sql) ||
        !(
          /^ALTER TABLE `WeleticRewardRedemption` ADD COLUMN/.test(sql) ||
          /^ALTER TABLE `WeleticLoyaltyOutboxJob` MODIFY `jobType` ENUM\(/.test(
            sql,
          ) ||
          /^ALTER TABLE `Weletic(ReviewSettings|ReviewRequest|ProductReview)` ADD COLUMN/.test(
            sql,
          ) ||
          /^CREATE TABLE `WeleticReviewIncentive(Policy|Claim)`/.test(sql) ||
          /^CREATE TABLE `WeleticReviewIncentiveInvalidation`/.test(sql) ||
          /^CREATE UNIQUE INDEX `wl_review_claim_store_id_uq` ON `WeleticReviewIncentiveClaim`/.test(
            sql,
          ) ||
          /^ALTER TABLE `WeleticShopifyVoucherCleanup` MODIFY `source` ENUM\(/.test(
            sql,
          ) ||
          /^CREATE TABLE `WeleticRewardCouponUse`/.test(sql) ||
          /^ALTER TABLE `WeleticProductReview` MODIFY `rewardStatus` ENUM\(/.test(
            sql,
          ) ||
          /^CREATE INDEX `wl_coupon_use_store_id_idx` ON `WeleticRewardCouponUse`/.test(
            sql,
          ) ||
          /^CREATE (UNIQUE )?INDEX `(wl_reward_|WeleticReview(Settings|Request)_storeId_)/.test(
            sql,
          )
        ),
    ) ||
    JSON.stringify(comparable(pending)) !== JSON.stringify(comparable(expected))
  )
    throw new Error(
      "The complete incentive expansion differs from reviewed SQL",
    );
  // Execute in the explicit reviewed phase order, never arbitrary input order.
  return expected;
}
