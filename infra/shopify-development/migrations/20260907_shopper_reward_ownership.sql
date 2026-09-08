-- AlterTable
ALTER TABLE `WeleticRewardRedemption` ADD COLUMN `fulfillmentReference` VARCHAR(191) NULL,
    ADD COLUMN `fulfillmentSource` VARCHAR(32) NULL,
    ADD COLUMN `shopperId` VARCHAR(191) NULL,
    MODIFY `accountId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `wl_reward_shopper_history_idx` ON `WeleticRewardRedemption`(`storeId`, `shopperId`, `createdAt`, `id`);

-- CreateIndex
CREATE UNIQUE INDEX `wl_reward_fulfillment_source_uq` ON `WeleticRewardRedemption`(`storeId`, `fulfillmentSource`, `fulfillmentReference`);
