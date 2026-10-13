// @ts-nocheck — Node `Buffer` is valid for `createCipheriv`; local @types/node uses strict ArrayBuffer branding.
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MIN_CIPHERTEXT_BYTES = IV_LENGTH + AUTH_TAG_LENGTH;

function loadEncryptionKey(): Buffer {
  const keyEnv = process.env.ENCRYPTION_KEY;
  if (!keyEnv) {
    throw new Error("ENCRYPTION_KEY is not set");
  }

  // Support base64 (44 chars)
  const base64Key = Buffer.from(keyEnv, "base64");
  if (base64Key.length === 32) {
    return base64Key;
  }

  // Support hex (64 chars)
  if (/^[0-9a-fA-F]{64}$/.test(keyEnv)) {
    const hexKey = Buffer.from(keyEnv, "hex");
    if (hexKey.length === 32) {
      return hexKey;
    }
  }

  // Fallback: SHA-256 hash to guarantee exactly 32 bytes
  return crypto.createHash("sha256").update(keyEnv).digest();
}

// AES-256-GCM encrypt.
export function encrypt(plaintext: string) {
  const key = loadEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

// AES-256-GCM decrypt. Throws on any failure (bad key, tampered ciphertext, plaintext input).
export function decrypt(payload: string) {
  if (!payload || typeof payload !== "string") {
    throw new Error(
      "Invalid decryption payload: payload must be a non-empty string",
    );
  }
  const key = loadEncryptionKey();
  const data = Buffer.from(payload, "base64");
  if (data.length < MIN_CIPHERTEXT_BYTES) {
    throw new Error(
      `Invalid ciphertext payload: byte length ${data.length} is less than minimum ${MIN_CIPHERTEXT_BYTES} bytes`,
    );
  }
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}

function isLikelyCiphertext(payload: string): boolean {
  if (typeof payload !== "string" || payload.length < 32) return false;
  const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
  if (!base64Regex.test(payload.trim())) return false;
  const buf = Buffer.from(payload, "base64");
  return buf.length >= MIN_CIPHERTEXT_BYTES;
}

function isKnownPlaintextToken(payload: string): boolean {
  if (typeof payload !== "string") return false;
  // Shopify offline/custom access tokens
  if (
    payload.startsWith("shpat_") ||
    payload.startsWith("shpua_") ||
    payload.startsWith("shpca_")
  ) {
    return true;
  }
  // Slack bot/user tokens
  if (
    payload.startsWith("xoxb-") ||
    payload.startsWith("xoxp-") ||
    payload.startsWith("xapp-")
  ) {
    return true;
  }
  // HubSpot private app tokens
  if (payload.startsWith("pat-")) {
    return true;
  }
  // Non-production test mock prefixes
  if (
    process.env.NODE_ENV !== "production" &&
    (payload.startsWith("test-") ||
      payload.startsWith("mock-") ||
      payload.startsWith("synthetic-") ||
      payload.startsWith("fake-") ||
      payload.startsWith("dummy-") ||
      payload.startsWith("sample-"))
  ) {
    return true;
  }
  return false;
}

/**
 * @deprecated Legacy migration helper. Call sites must migrate to `decrypt()`.
 * Hardened fail-closed behavior:
 * - Configuration errors (missing ENCRYPTION_KEY): ALWAYS throws.
 * - Ciphertext tampering, corruption, or authentication failure: ALWAYS throws.
 * - Recognized legacy plaintext tokens (e.g. shpat_): Permitted with migration warning.
 * - Unknown/malformed tokens: Throws (fail closed).
 */
export function decryptOrPassthrough(payload: string): string {
  if (!payload || typeof payload !== "string") {
    throw new Error(
      "[decryptOrPassthrough] Payload must be a non-empty string",
    );
  }

  // 1. Fail closed on missing encryption key — never swallow configuration errors
  loadEncryptionKey();

  // 2. Check if payload appears to be ciphertext
  if (isLikelyCiphertext(payload)) {
    try {
      return decrypt(payload);
    } catch (err: any) {
      // Ciphertext format but decryption/authentication failed -> FAIL CLOSED!
      throw new Error(
        `[decryptOrPassthrough] Security validation failed: ciphertext authentication error: ${err.message}`,
      );
    }
  }

  // 3. Check if payload is a recognized legacy plaintext token format
  if (isKnownPlaintextToken(payload)) {
    console.warn(
      `[decryptOrPassthrough] Deprecation warning: Unencrypted token accessed. Backfill and encrypt this token in database.`,
    );
    return payload;
  }

  // 4. Unknown/malformed payload: FAIL CLOSED
  throw new Error(
    `[decryptOrPassthrough] Invalid token: payload is neither valid ciphertext nor recognized plaintext token format`,
  );
}
