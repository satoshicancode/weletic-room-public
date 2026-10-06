import { describe, expect, it } from "vitest";
import { hashStringSHA256, nanoid } from "../src/functions";

describe("hashStringSHA256", () => {
  it("produces standard SHA-256 hash for empty string", async () => {
    const hash = await hashStringSHA256("");
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hash).toHaveLength(64);
  });

  it("produces standard SHA-256 hash for known test vectors", async () => {
    const hash = await hashStringSHA256("hello");
    expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("handles multi-byte UTF-8 Unicode characters deterministically", async () => {
    const hashJa = await hashStringSHA256("日本語テスト");
    const hashJaAgain = await hashStringSHA256("日本語テスト");
    expect(hashJa).toHaveLength(64);
    expect(hashJa).toBe(hashJaAgain);

    const hashVi = await hashStringSHA256("Thử nghiệm Tiếng Việt có dấu");
    expect(hashVi).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hashVi)).toBe(true);
  });

  it("produces different hashes for different inputs", async () => {
    const hash1 = await hashStringSHA256("string_1");
    const hash2 = await hashStringSHA256("string_2");
    expect(hash1).not.toBe(hash2);
  });
});

describe("nanoid", () => {
  it("generates a 7-character string by default", () => {
    const id = nanoid();
    expect(typeof id).toBe("string");
    expect(id).toHaveLength(7);
  });

  it("generates strings with custom lengths", () => {
    expect(nanoid(10)).toHaveLength(10);
    expect(nanoid(16)).toHaveLength(16);
    expect(nanoid(32)).toHaveLength(32);
    expect(nanoid(1)).toHaveLength(1);
  });

  it("uses alphanumeric charset (0-9, a-z, A-Z)", () => {
    const pattern = /^[0-9A-Za-z]+$/;
    for (let i = 0; i < 50; i++) {
      const id = nanoid(20);
      expect(pattern.test(id)).toBe(true);
    }
  });

  it("generates distinct, unique identifiers", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(nanoid(10));
    }
    expect(ids.size).toBe(1000);
  });
});
