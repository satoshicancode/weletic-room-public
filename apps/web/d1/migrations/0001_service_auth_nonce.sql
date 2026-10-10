-- Migration: 0001_service_auth_nonce.sql
-- Description: Provision distributed replay attack protection table for Cloudflare D1 service auth

CREATE TABLE IF NOT EXISTS "ServiceAuthNonce" (
    "nonceKey" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "ServiceAuthNonce_expiresAt_idx" ON "ServiceAuthNonce"("expiresAt");
