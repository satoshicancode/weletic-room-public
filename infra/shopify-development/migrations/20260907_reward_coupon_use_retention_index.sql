-- Durable store-scoped keyset retention pages.
CREATE INDEX `wl_coupon_use_store_id_idx` ON `WeleticRewardCouponUse`(`storeId`, `id`);
