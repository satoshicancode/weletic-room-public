-- Migration: 20261005_commission_bigint_overflow_fix.sql
-- Description: Upgrade Commission amount and earnings columns to BIGINT to prevent Int32 overflow on zero-decimal currencies (VND, JPY).

ALTER TABLE `Commission`
  MODIFY COLUMN `amount` BIGINT NOT NULL,
  MODIFY COLUMN `earnings` BIGINT NOT NULL DEFAULT 0;
