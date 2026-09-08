import {
  loyaltyErrorResponse,
  loyaltySuccessResponse,
  serializeLoyaltyData,
} from "@/lib/weletic/loyalty/serialization";
import { Prisma } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Milestone 1 (M1) Challenger 2: Data Precision & PII Adversarial Verification", () => {
  describe("1. Extreme BigInt Points & Arbitrary-Precision Serialization", () => {
    it("preserves exact precision for extreme BigInt values exceeding 2^53 - 1 and 2^64", () => {
      const maxSafe = BigInt("9007199254740991"); // 2^53 - 1
      const maxSafePlus1 = BigInt("9007199254740992");
      const maxSafePlus2 = BigInt("9007199254740993");
      const int64Min = BigInt("-9223372036854775808");
      const int64Max = BigInt("9223372036854775807");
      const uint64Max = BigInt("18446744073709551615");
      const uint128 = BigInt("340282366920938463463374607431768211455"); // 2^128 - 1
      const huge100Digit = BigInt("9".repeat(100));

      const payload = {
        zero: BigInt(0),
        one: BigInt(1),
        negOne: BigInt(-1),
        maxSafe,
        maxSafePlus1,
        maxSafePlus2,
        int64Min,
        int64Max,
        uint64Max,
        uint128,
        huge100Digit,
      };

      const serialized = serializeLoyaltyData(payload);

      // Verify that direct serialization matches exact string representation
      expect(serialized.zero).toBe("0");
      expect(serialized.one).toBe("1");
      expect(serialized.negOne).toBe("-1");
      expect(serialized.maxSafe).toBe("9007199254740991");
      expect(serialized.maxSafePlus1).toBe("9007199254740992");
      expect(serialized.maxSafePlus2).toBe("9007199254740993");
      expect(serialized.int64Min).toBe("-9223372036854775808");
      expect(serialized.int64Max).toBe("9223372036854775807");
      expect(serialized.uint64Max).toBe("18446744073709551615");
      expect(serialized.uint128).toBe(
        "340282366920938463463374607431768211455",
      );
      expect(serialized.huge100Digit).toBe("9".repeat(100));

      // Native JSON.stringify MUST succeed without throwing TypeError: Do not know how to serialize a BigInt
      const jsonString = JSON.stringify(serialized);
      const parsed = JSON.parse(jsonString);

      expect(parsed.maxSafePlus2).toBe("9007199254740993");
      expect(parsed.uint64Max).toBe("18446744073709551615");
      expect(parsed.huge100Digit).toBe("9".repeat(100));
    });

    it("handles zero-decimal currencies (JPY, VND, KRW) and arbitrary Prisma.Decimal values", () => {
      const jpyPoints = BigInt(150000); // ¥150,000 JPY
      const vndPoints = BigInt(50000000); // ₫50,000,000 VND
      const decimalRate = new Prisma.Decimal("1.0000");
      const subCentDecimal = new Prisma.Decimal("0.00000001");
      const highPrecisionLiability = new Prisma.Decimal(
        "9876543210987654.3210",
      );
      const negativeDecimal = new Prisma.Decimal("-1234567.89");

      const payload = {
        jpyBalance: jpyPoints,
        vndBalance: vndPoints,
        rate: decimalRate,
        microRate: subCentDecimal,
        totalLiability: highPrecisionLiability,
        negativeAmount: negativeDecimal,
        zeroDecimal: new Prisma.Decimal("0.00"),
      };

      const serialized = serializeLoyaltyData(payload);

      expect(serialized.jpyBalance).toBe("150000");
      expect(serialized.vndBalance).toBe("50000000");
      expect(serialized.rate).toBe("1");
      expect(serialized.microRate).toBe("1e-8");
      expect(serialized.totalLiability).toBe("9876543210987654.321");
      expect(serialized.negativeAmount).toBe("-1234567.89");
      expect(serialized.zeroDecimal).toBe("0");

      const jsonStr = JSON.stringify(serialized);
      expect(JSON.parse(jsonStr)).toEqual({
        jpyBalance: "150000",
        vndBalance: "50000000",
        rate: "1",
        microRate: "1e-8",
        totalLiability: "9876543210987654.321",
        negativeAmount: "-1234567.89",
        zeroDecimal: "0",
      });
    });
  });

  describe("2. Deeply Nested & Heterogeneous Structures", () => {
    it("correctly traverses 10-level deep objects and nested arrays", () => {
      const deepStructure = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: {
                  level6: {
                    level7: {
                      level8: {
                        level9: {
                          level10: {
                            targetBigInt: BigInt("9999999999999999"),
                            targetDecimal: new Prisma.Decimal("42.42"),
                            targetDate: new Date("2026-08-26T12:00:00.000Z"),
                            targetArray: [
                              BigInt(1),
                              BigInt(2),
                              [BigInt(3), new Prisma.Decimal("4.0")],
                            ],
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };

      const serialized = serializeLoyaltyData(deepStructure);

      expect(
        serialized.level1.level2.level3.level4.level5.level6.level7.level8
          .level9.level10.targetBigInt,
      ).toBe("9999999999999999");
      expect(
        serialized.level1.level2.level3.level4.level5.level6.level7.level8
          .level9.level10.targetDecimal,
      ).toBe("42.42");
      expect(
        serialized.level1.level2.level3.level4.level5.level6.level7.level8
          .level9.level10.targetDate,
      ).toBe("2026-08-26T12:00:00.000Z");
      expect(
        serialized.level1.level2.level3.level4.level5.level6.level7.level8
          .level9.level10.targetArray,
      ).toEqual(["1", "2", ["3", "4"]]);
    });

    it("handles null prototypes, empty structures, null, and undefined values cleanly", () => {
      const nullProtoObj = Object.create(null);
      nullProtoObj.keyA = BigInt(100);
      nullProtoObj.keyB = "value";

      const payload = {
        nullVal: null,
        undefinedVal: undefined,
        emptyObj: {},
        emptyArray: [],
        mixedArray: [
          null,
          undefined,
          42,
          "hello",
          BigInt(100),
          { inner: BigInt(200) },
        ],
        nullProto: nullProtoObj,
      };

      const serialized = serializeLoyaltyData(payload);

      expect(serialized.nullVal).toBeNull();
      expect(serialized.undefinedVal).toBeUndefined();
      expect(serialized.emptyObj).toEqual({});
      expect(serialized.emptyArray).toEqual([]);
      expect(serialized.mixedArray).toEqual([
        null,
        undefined,
        42,
        "hello",
        "100",
        { inner: "200" },
      ]);
      expect(serialized.nullProto).toEqual({
        keyA: "100",
        keyB: "value",
      });
    });
  });

  describe("3. Response Envelopes & Error Code Contracts", () => {
    it("formats loyaltySuccessResponse with standard { data: ... } envelope and headers", async () => {
      const payload = {
        account: {
          id: "acc_xyz",
          pointsBalance: BigInt("12345678901234567"),
          createdAt: new Date("2026-08-26T08:30:00.000Z"),
        },
      };

      const res = loyaltySuccessResponse(payload, {
        status: 201,
        headers: { "X-Custom-Trace": "trace-1234" },
      });

      expect(res.status).toBe(201);
      expect(res.headers.get("X-Custom-Trace")).toBe("trace-1234");

      const json = await res.json();
      expect(json).toEqual({
        data: {
          account: {
            id: "acc_xyz",
            pointsBalance: "12345678901234567",
            createdAt: "2026-08-26T08:30:00.000Z",
          },
        },
      });
    });

    it("formats loyaltyErrorResponse with standard { error: { code, message } } and optional details", async () => {
      // Test without details
      const resWithoutDetails = loyaltyErrorResponse(
        "forbidden",
        "Owner permissions required",
        403,
      );

      expect(resWithoutDetails.status).toBe(403);
      const jsonWithoutDetails = await resWithoutDetails.json();
      expect(jsonWithoutDetails).toEqual({
        error: {
          code: "forbidden",
          message: "Owner permissions required",
        },
      });

      // Test with details containing BigInt and Decimal
      const resWithDetails = loyaltyErrorResponse(
        "insufficient_balance",
        "Customer has insufficient points balance",
        422,
        {
          currentBalance: BigInt(150),
          requiredPoints: BigInt(500),
          shortfall: BigInt(350),
          minCurrencyEquivalent: new Prisma.Decimal("3.50"),
        },
        { headers: { "X-Error-Reason": "low_balance" } },
      );

      expect(resWithDetails.status).toBe(422);
      expect(resWithDetails.headers.get("X-Error-Reason")).toBe("low_balance");

      const jsonWithDetails = await resWithDetails.json();
      expect(jsonWithDetails).toEqual({
        error: {
          code: "insufficient_balance",
          message: "Customer has insufficient points balance",
          details: {
            currentBalance: "150",
            requiredPoints: "500",
            shortfall: "350",
            minCurrencyEquivalent: "3.5",
          },
        },
      });
    });
  });

  describe("4. Storefront Liquid & JavaScript DOM PII Leak Scan", () => {
    const extensionsDir = path.resolve(
      __dirname,
      "../../../../packages/shopify-app/extensions",
    );

    function scanFiles(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...scanFiles(fullPath));
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
      return files;
    }

    it("verifies zero cleartext customer PII tokens in any Shopify storefront extension files", () => {
      const allFiles = scanFiles(extensionsDir);
      expect(allFiles.length).toBeGreaterThan(0);

      // Banned cleartext Liquid customer PII tags
      const bannedLiquidTags = [
        /\{\{\s*customer\.email\s*\}\}/i,
        /\{\{\s*customer\.first_name\s*\}\}/i,
        /\{\{\s*customer\.last_name\s*\}\}/i,
        /\{\{\s*customer\.name\s*\}\}/i,
        /\{\{\s*customer\.phone\s*\}\}/i,
        /\{\{\s*customer\.default_address/i,
      ];

      // Banned DOM attributes that leak PII into cleartext DOM tree
      const bannedDomAttributes = [
        /data-customer-email/i,
        /data-customer-first-name/i,
        /data-customer-last-name/i,
        /data-customer-phone/i,
      ];

      for (const filePath of allFiles) {
        if (filePath.endsWith(".map") || filePath.endsWith(".png")) continue;
        const content = fs.readFileSync(filePath, "utf-8");

        for (const tagRegex of bannedLiquidTags) {
          expect(
            tagRegex.test(content),
            `Banned Liquid PII tag ${tagRegex} found in ${filePath}`,
          ).toBe(false);
        }

        for (const attrRegex of bannedDomAttributes) {
          expect(
            attrRegex.test(content),
            `Banned DOM PII attribute ${attrRegex} found in ${filePath}`,
          ).toBe(false);
        }
      }
    });

    it("verifies weletic-loyalty-widget.js fetches shopper profile securely via authenticated API without DOM PII reading", () => {
      const widgetPath = path.join(
        extensionsDir,
        "weletic-analytics/assets/weletic-loyalty-widget.js",
      );
      const content = fs.readFileSync(widgetPath, "utf-8");

      expect(content).not.toContain('root.getAttribute("data-customer-email")');
      expect(content).not.toContain(
        'root.getAttribute("data-customer-first-name")',
      );
      expect(content).not.toContain(
        'root.getAttribute("data-customer-last-name")',
      );
      expect(content).not.toContain('root.getAttribute("data-customer-phone")');

      // Verifies customer data is derived from API response in memory
      expect(content).toContain("loyaltyData.shopper.firstName");
      expect(content).toContain("/api/shopify/loyalty/customer");
    });
  });
});
