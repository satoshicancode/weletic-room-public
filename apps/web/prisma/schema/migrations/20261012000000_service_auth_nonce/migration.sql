-- RedefineTables
-- ServiceAuthNonce.expiresAt: Int -> BigInt (epoch milliseconds overflow 32 bits).
-- The nonce table only holds short-lived replay-protection rows, so copying is cheap.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
