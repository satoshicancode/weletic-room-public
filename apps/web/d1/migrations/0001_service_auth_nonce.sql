-- Migration: 0001_service_auth_nonce.sql
-- Description: Provision distributed replay attack protection table for Cloudflare D1 service auth with 64-bit epoch ms

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE IF NOT EXISTS "ServiceAuthNonce" (
    "nonceKey" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" BIGINT NOT NULL
);
CREATE TABLE "new_ServiceAuthNonce" (
    "nonceKey" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" BIGINT NOT NULL
);
INSERT INTO "new_ServiceAuthNonce" ("expiresAt", "nonceKey") SELECT "expiresAt", "nonceKey" FROM "ServiceAuthNonce";
DROP TABLE "ServiceAuthNonce";
ALTER TABLE "new_ServiceAuthNonce" RENAME TO "ServiceAuthNonce";
CREATE INDEX "ServiceAuthNonce_expiresAt_idx" ON "ServiceAuthNonce"("expiresAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
