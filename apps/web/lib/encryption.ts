// @ts-nocheck — Node `Buffer` is valid for `createCipheriv`; local @types/node uses strict ArrayBuffer branding.
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

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
  const key = loadEncryptionKey();
  const data = Buffer.from(payload, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = data.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}

// Tolerant variant: successful decrypt(payload) returns plaintext; if decrypt throws, this returns the input unchanged.
// Should be removed after migration is complete.
export function decryptOrPassthrough(payload: string) {
  try {
    return decrypt(payload);
  } catch {
    console.warn(
      "[decryptOrPassthrough] decrypt failed, returning input as plaintext",
    );
    return payload;
  }
}
