import {
  HISTORICAL_IMPORT_MAX_SOURCE_BYTES,
  HISTORICAL_IMPORT_MAX_SOURCE_ROWS,
  parseHistoricalImportSource,
} from "@/lib/weletic/loyalty/historical-import-source";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const row = {
  shopifyCustomerId: "gid://shopify/Customer/123",
  openingBalance: "9007199254740993",
};
function parse(text: string, format: "csv" | "json" = "json") {
  const bytes = new TextEncoder().encode(text);
  return parseHistoricalImportSource({
    bytes,
    source: {
      format,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  });
}

describe("historical import source", () => {
  it("accepts the CSV row boundary and rejects overflow without truncation", () => {
    const header = "shopifyCustomerId,openingBalance\n";
    const rows = Array.from(
      { length: HISTORICAL_IMPORT_MAX_SOURCE_ROWS },
      (_, index) => `gid://shopify/Customer/${index + 1},0`,
    );
    expect(parse(header + rows.join("\n"), "csv").rows).toHaveLength(
      HISTORICAL_IMPORT_MAX_SOURCE_ROWS,
    );
    expect(() =>
      parse(
        header + rows.join("\n") + "\ngid://shopify/Customer/50001,0",
        "csv",
      ),
    ).toThrow("invalid_source");
  });
  it("binds exact source bytes while normalizing field ordering", () => {
    const first = parse(JSON.stringify([row]));
    const second = parse(
      JSON.stringify(
        [
          {
            openingBalance: row.openingBalance,
            shopifyCustomerId: row.shopifyCustomerId,
          },
        ],
        null,
        2,
      ),
    );
    expect(first.source.sha256).not.toBe(second.source.sha256);
    expect(first.normalizedSha256).toBe(second.normalizedSha256);
    expect(first.totalOpeningBalance).toBe(row.openingBalance);
  });
  it("binds changes to row values and sequence", () => {
    const other = { ...row, shopifyCustomerId: "gid://shopify/Customer/456" };
    expect(parse(JSON.stringify([row, other])).normalizedSha256).not.toBe(
      parse(JSON.stringify([other, row])).normalizedSha256,
    );
    expect(parse(JSON.stringify([row])).normalizedSha256).not.toBe(
      parse(JSON.stringify([{ ...row, openingBalance: "1" }])).normalizedSha256,
    );
  });
  it("parses quoted CSV fields and optional birthday/tier columns", () => {
    const result = parse(
      'shopifyCustomerId,openingBalance,birthdayMonth,birthdayDay,tierId\r\n"gid://shopify/Customer/123","9007199254740993",2,29,tier-1\r\n',
      "csv",
    );
    expect(result.rows).toEqual([
      { ...row, birthday: { month: 2, day: 29 }, tierId: "tier-1" },
    ]);
  });
  it("normalizes CSV and JSON to the same row digest", () => {
    expect(
      parse(
        `openingBalance,shopifyCustomerId\n${row.openingBalance},${row.shopifyCustomerId}`,
        "csv",
      ).normalizedSha256,
    ).toBe(parse(JSON.stringify([row])).normalizedSha256);
  });
  it.each([
    "shopifyCustomerId,openingBalance,openingBalance\na,1,1",
    "shopifyCustomerId,openingBalance,unknown\na,1,x",
    "shopifyCustomerId,openingBalance,birthdayMonth\na,1,2",
    "shopifyCustomerId,openingBalance\ngid://shopify/Customer/123,1,extra",
    'shopifyCustomerId,openingBalance\n"unterminated,1',
  ])("rejects malformed CSV without echoing its content", (text) => {
    expect(() => parse(text, "csv")).toThrow(
      /Historical import (invalid_source|invalid_row)/,
    );
  });
  it("rejects duplicate customers across request-batch boundaries", () => {
    const rows = Array.from({ length: 1001 }, (_, index) => ({
      ...row,
      shopifyCustomerId: `gid://shopify/Customer/${index + 1}`,
    }));
    rows.push(rows[0]);
    expect(() => parse(JSON.stringify(rows))).toThrow(
      "duplicate_customer at row 1002",
    );
  });
  it("does not trust a client-supplied hash", () => {
    expect(() =>
      parseHistoricalImportSource({
        bytes: new TextEncoder().encode("[]"),
        source: { format: "json", sha256: "0".repeat(64) },
      }),
    ).toThrow("source_mismatch");
  });
  it("rejects invalid UTF-8 rather than replacing bytes", () => {
    const bytes = new Uint8Array([255]);
    expect(() =>
      parseHistoricalImportSource({
        bytes,
        source: {
          format: "json",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      }),
    ).toThrow("invalid_source");
  });
  it("rejects oversized input before parsing", () => {
    expect(() =>
      parseHistoricalImportSource({
        bytes: new Uint8Array(HISTORICAL_IMPORT_MAX_SOURCE_BYTES + 1),
        source: { format: "json", sha256: "0".repeat(64) },
      }),
    ).toThrow("invalid_source");
  });
  it.each([
    "[]",
    "{}",
    "not json",
    '[{"shopifyCustomerId":"private@example.com","openingBalance":"1"}]',
  ])("rejects invalid JSON rows with sanitized errors", (text) => {
    expect(() => parse(text)).toThrow(/Historical import invalid_(source|row)/);
  });
});
