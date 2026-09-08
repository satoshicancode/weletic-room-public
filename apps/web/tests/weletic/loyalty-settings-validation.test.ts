import {
  LoyaltySettingsValidationError,
  readNonNegativeInteger,
  readNullablePositiveBigInt,
  readPositiveDecimal,
} from "@/lib/weletic/loyalty/settings-validation";
import { describe, expect, it } from "vitest";

describe("shared loyalty settings numeric validation", () => {
  it("preserves omitted values and explicit valuation clearing", () => {
    expect(readNullablePositiveBigInt(undefined, "numerator")).toBeUndefined();
    expect(readNullablePositiveBigInt(null, "numerator")).toBeNull();
    expect(readPositiveDecimal(undefined, "rate")).toBeUndefined();
    expect(readNonNegativeInteger(undefined, "days", 365)).toBeUndefined();
  });

  it("keeps 1/100 JPY valuation and signed-64-bit boundaries exact", () => {
    expect(readNullablePositiveBigInt("1", "numerator")).toBe(BigInt("1"));
    expect(readNullablePositiveBigInt("100", "denominator")).toBe(
      BigInt("100"),
    );
    expect(readNullablePositiveBigInt("9223372036854775807", "numerator")).toBe(
      BigInt("9223372036854775807"),
    );
    expect(() =>
      readNullablePositiveBigInt("9223372036854775808", "numerator"),
    ).toThrow("numerator exceeds the supported 64-bit integer range.");
  });

  it.each([
    0,
    1,
    BigInt("100"),
    "0",
    "01",
    "-1",
    "+1",
    "1.0",
    "1e2",
    " 1",
    "",
    {},
    true,
  ])("rejects noncanonical valuation input %s", (value) => {
    expect(() => readNullablePositiveBigInt(value, "numerator")).toThrow(
      LoyaltySettingsValidationError,
    );
  });

  it("does not round decimal strings through binary floating point", () => {
    expect(
      readPositiveDecimal("1.0000000000000000001", "rate")?.toString(),
    ).toBe("1.0000000000000000001");
    expect(readPositiveDecimal("0.001", "rate")?.toString()).toBe("0.001");
    expect(readPositiveDecimal(1.25, "rate")?.toString()).toBe("1.25");
  });

  it.each([
    null,
    false,
    {},
    "",
    " ",
    "invalid",
    0,
    -1,
    Infinity,
    NaN,
    "Infinity",
    "NaN",
  ])("rejects invalid positive decimal %s", (value) => {
    expect(() => readPositiveDecimal(value, "rate")).toThrow(
      "rate must be a positive decimal.",
    );
  });

  it("preserves legacy numeric-string compatibility for integer settings", () => {
    expect(readNonNegativeInteger(" 365 ", "days", 365)).toBe(365);
    expect(readNonNegativeInteger("0", "days", 365)).toBe(0);
    expect(readNonNegativeInteger(0, "days", 365)).toBe(0);
    expect(readNonNegativeInteger("1e2", "days", 365)).toBe(100);
    expect(readNonNegativeInteger(Number.MAX_SAFE_INTEGER, "count")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it.each([
    null,
    false,
    {},
    [],
    "",
    " ",
    "invalid",
    -1,
    0.1,
    366,
    Infinity,
    NaN,
  ])("rejects invalid bounded integer %s", (value) => {
    expect(() => readNonNegativeInteger(value, "days", 365)).toThrow(
      "days must be a non-negative integer no greater than 365.",
    );
  });

  it("rejects unsafe integers even without a configured maximum", () => {
    expect(() =>
      readNonNegativeInteger(Number.MAX_SAFE_INTEGER + 1, "count"),
    ).toThrow("count must be a non-negative integer.");
  });
});
