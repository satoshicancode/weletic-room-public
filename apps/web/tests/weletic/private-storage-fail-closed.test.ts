import { afterEach, describe, expect, it } from "vitest";
import { storage } from "../../lib/storage";

const names = [
  "STORAGE_ENDPOINT",
  "STORAGE_PRIVATE_BUCKET",
  "STORAGE_PUBLIC_BUCKET",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
] as const;
const original = Object.fromEntries(
  names.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of names) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("private storage configuration", () => {
  it("never uses the public development fallback for private uploads or deletes", async () => {
    for (const name of names) delete process.env[name];
    await expect(
      storage.upload({
        key: "compliance/private.enc",
        body: Buffer.from("ciphertext"),
        bucket: "private",
      }),
    ).rejects.toThrow("Private storage is not fully configured");
    await expect(
      storage.delete({ key: "compliance/private.enc", bucket: "private" }),
    ).rejects.toThrow("Private storage is not fully configured");
  });
});
