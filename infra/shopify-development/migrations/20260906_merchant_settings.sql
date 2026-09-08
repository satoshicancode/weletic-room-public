-- CreateTable
CREATE TABLE `WeleticMerchantSettings` (
    `storeId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `brandName` VARCHAR(100) NULL,
    `logoUrl` VARCHAR(2048) NULL,
    `accentColor` VARCHAR(7) NULL,
    `timeZone` VARCHAR(100) NULL,
    `shopperEmailPaused` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`storeId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
