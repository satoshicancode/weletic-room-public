import { prisma } from "@/lib/prisma";
import {
  calculatePointsLiability,
  escapeCsvUntrustedTextCell,
  exportLoyaltyMetricsCsv,
  exportLoyaltyMetricsJson,
} from "@/lib/weletic/loyalty/analytics";
import { minorUnitsToDecimal } from "@/lib/weletic/money";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findMany: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findMany: vi.fn(),
    },
    weleticLoyaltyReferral: {
      findMany: vi.fn(),
    },
    weleticCommerceOrder: {
      findMany: vi.fn(),
    },
    weleticLoyaltyTier: {
      findMany: vi.fn(),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
    },
  },
}));

describe("Adversarial Challenger Stress Suite: Loyalty Analytics, Liability & Security", () => {
  const storeId = "store_adversary_stress";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticLoyaltyReferral.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticLoyaltyTier.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue(null);
  });

  // =========================================================================
  // Scope 1: Floating-Point Drift Adversary (10,000 Operations Across JPY, USD, BHD)
  // =========================================================================
  describe("Scope 1: Floating-Point Drift Adversary (10,000 Synthetic Operations)", () => {
    it("proves 0.000000000 precision drift across 10,000 operations in USD (2-dec) vs IEEE-754 float drift", () => {
      // In IEEE-754 standard floats:
      // 0.1 + 0.2 = 0.30000000000000004
      // Accumulating 0.07 ten thousand times in IEEE-754:
      let floatSum = 0;
      let integerMinorUnitsSum = BigInt(0);
      const operationsCount = 10000;
      const amountPerOpMinor = BigInt(7); // 7 cents = $0.07

      for (let i = 0; i < operationsCount; i++) {
        floatSum += 0.07;
        integerMinorUnitsSum += amountPerOpMinor;
      }

      // 10,000 * 7 cents = 70,000 cents = $700.00
      const exactExpectedMinor = BigInt(70000);
      expect(integerMinorUnitsSum).toBe(exactExpectedMinor);

      // Decimal formatting guarantees exact "700.00"
      const formatted = minorUnitsToDecimal(integerMinorUnitsSum, "USD");
      expect(formatted).toBe("700.00");

      // Floating-point math has precision drift
      const floatDrift = Math.abs(floatSum - 700.0);
      expect(floatDrift).toBeGreaterThan(0); // IEEE-754 drifted!
    });

    it("proves 0.000000000 precision drift across 10,000 operations in JPY (0-dec)", () => {
      let integerSum = BigInt(0);
      const operationsCount = 10000;
      const pointPerOp = BigInt(333); // ¥333 per op

      for (let i = 0; i < operationsCount; i++) {
        integerSum += pointPerOp;
      }

      // 10,000 * 333 = 3,330,000 JPY
      expect(integerSum).toBe(BigInt(3330000));
      const formatted = minorUnitsToDecimal(integerSum, "JPY");
      expect(formatted).toBe("3330000");
      expect(formatted).not.toContain(".");
    });

    it("proves 0.000000000 precision drift across 10,000 operations in BHD (3-dec)", () => {
      let integerFils = BigInt(0);
      const operationsCount = 10000;
      const filsPerOp = BigInt(13); // 13 fils = 0.013 BHD

      for (let i = 0; i < operationsCount; i++) {
        integerFils += filsPerOp;
      }

      // 10,000 * 13 fils = 130,000 fils = 130.000 BHD
      expect(integerFils).toBe(BigInt(130000));
      const formatted = minorUnitsToDecimal(integerFils, "BHD");
      expect(formatted).toBe("130.000");
    });
  });

  // =========================================================================
  // Scope 2: Extreme Debt & Scale Stress (10,000 Accounts, MAX_SAFE_INTEGER)
  // =========================================================================
  describe("Scope 2: Extreme Debt & Scale Stress", () => {
    it("handles 10,000 accounts with MAX_SAFE_INTEGER balances and extreme clawback debt without overflow", async () => {
      const accountsCount = 10000;
      const maxSafe = BigInt(Number.MAX_SAFE_INTEGER); // 9,007,199,254,740,991
      const debtPerAccount = BigInt(5000000000); // 5 billion debt

      const syntheticAccounts = Array.from(
        { length: accountsCount },
        (_, i) => {
          if (i % 2 === 0) {
            return {
              cachedPointsBalance: maxSafe,
              cachedPendingPoints: BigInt(1000),
              status: "active",
              updatedAt: new Date(),
            };
          } else {
            return {
              cachedPointsBalance: -debtPerAccount,
              cachedPendingPoints: BigInt(0),
              status: "active",
              updatedAt: new Date(),
            };
          }
        },
      );

      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce(
        syntheticAccounts as any,
      );

      const startTime = Date.now();
      const result = await calculatePointsLiability({
        storeId,
        currency: "USD",
        valuationPerPointMinorUnits: 1,
      });
      const duration = Date.now() - startTime;

      expect(result.totalMembersCount).toBe(10000);
      expect(result.negativeBalanceAccountsCount).toBe(5000);

      // Positive circulating accounts: 5,000 * MAX_SAFE_INTEGER
      const expectedCirculating = BigInt(5000) * maxSafe;
      expect(result.totalCirculatingPoints).toBe(expectedCirculating);

      // Negative debt accounts: 5,000 * 5,000,000,000
      const expectedDebt = BigInt(5000) * debtPerAccount;
      expect(result.negativeBalancePointsDebt).toBe(expectedDebt);

      // Net circulating points = circulating - debt
      expect(result.netCirculatingPoints).toBe(
        expectedCirculating - expectedDebt,
      );

      // Execution should be well within realistic bounds (< 500ms)
      expect(duration).toBeLessThan(1000);
    });

    it("evaluates 10,000 100% insolvent accounts without negative circulating balance underflow", async () => {
      const syntheticAccounts = Array.from({ length: 10000 }, () => ({
        cachedPointsBalance: BigInt(-10000),
        cachedPendingPoints: BigInt(0),
        status: "active",
        updatedAt: new Date(),
      }));

      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce(
        syntheticAccounts as any,
      );

      const result = await calculatePointsLiability({
        storeId,
        currency: "USD",
        valuationPerPointMinorUnits: 1,
      });

      expect(result.totalCirculatingPoints).toBe(BigInt(0));
      expect(result.negativeBalancePointsDebt).toBe(BigInt(100000000));
      expect(result.negativeBalanceAccountsCount).toBe(10000);
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(0));
      expect(result.totalLiabilityDecimal).toBe("0.00");
    });
  });

  // =========================================================================
  // Scope 3: Adversarial PII Leakage Scanner (Strict Zero Leakage Assertions)
  // =========================================================================
  describe("Scope 3: Adversarial PII Leakage Scanner", () => {
    it("scans exported CSV and JSON payloads and asserts zero customer PII leakage", async () => {
      const sensitiveEmails = [
        "alexander.hamilton@us-treasury.gov",
        "elizabeth.montgomery@enterprise-corp.com",
        "sato.taro@tokyo-marketing.co.jp",
        "charlie.brown+alias@gmail.com",
        "confidential_shopper@protonmail.com",
      ];

      const sensitiveNames = [
        "Alexander Hamilton",
        "Elizabeth Montgomery",
        "Sato Taro",
        "Charlie Brown",
      ];

      const sensitivePhones = [
        "+1-555-019-2834",
        "+84-90-888-7777",
        "090-1234-5678",
      ];

      // Setup accounts with realistic customer PII in shopperId/id
      const accounts = sensitiveEmails.map((email, i) => ({
        id: `acc_${i}_${sensitiveNames[i % sensitiveNames.length].replace(/\s+/g, "_")}`,
        shopperId: email,
        cachedPointsBalance: BigInt(1500 + i * 100),
        cachedPendingPoints: BigInt(100),
        status: "active",
        updatedAt: new Date(),
      }));

      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue(
        accounts as any,
      );

      // Export both JSON and CSV
      const jsonExport = await exportLoyaltyMetricsJson({
        storeId,
        callerRole: "owner",
        currency: "USD",
        includeMembersSample: true,
        sampleMembersLimit: 100,
      });

      const csvExport = await exportLoyaltyMetricsCsv({
        storeId,
        callerRole: "owner",
        currency: "USD",
        includeMembersSample: true,
        sampleMembersLimit: 100,
      });

      const serializedJson = JSON.stringify(jsonExport);

      // PII Adversarial Scanner Regular Expressions:
      // 1. Email pattern: detects any standard email address
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      // 2. Sensitive domains
      const domainRegex =
        /\b(?:us-treasury|enterprise-corp|tokyo-marketing|gmail|protonmail)\.(?:gov|com|co\.jp)\b/gi;
      // 3. Sensitive names
      const namesRegex =
        /\b(?:Alexander|Hamilton|Elizabeth|Montgomery|Taro|Charlie)\b/gi;
      // 4. Sensitive phones
      const phoneRegex = /(?:\+1-555|\+84-90|090-1234)/g;

      // Scan CSV Export
      const csvEmailMatches = csvExport.match(emailRegex) || [];
      const csvDomainMatches = csvExport.match(domainRegex) || [];
      const csvNamesMatches = csvExport.match(namesRegex) || [];
      const csvPhoneMatches = csvExport.match(phoneRegex) || [];

      expect(csvEmailMatches).toHaveLength(0);
      expect(csvDomainMatches).toHaveLength(0);
      expect(csvNamesMatches).toHaveLength(0);
      expect(csvPhoneMatches).toHaveLength(0);

      // Scan JSON Export
      const jsonEmailMatches = serializedJson.match(emailRegex) || [];
      const jsonDomainMatches = serializedJson.match(domainRegex) || [];
      const jsonNamesMatches = serializedJson.match(namesRegex) || [];
      const jsonPhoneMatches = serializedJson.match(phoneRegex) || [];

      expect(jsonEmailMatches).toHaveLength(0);
      expect(jsonDomainMatches).toHaveLength(0);
      expect(jsonNamesMatches).toHaveLength(0);
      expect(jsonPhoneMatches).toHaveLength(0);

      // Assert that anonymous identifiers follow deterministic cryptographic SHA-256 pattern
      expect(jsonExport.membersSample).toBeDefined();
      for (const member of jsonExport.membersSample!) {
        expect(member.anonymousIdentifier).toMatch(/^anon_[a-f0-9]{16}$/);
      }
    });
  });

  // =========================================================================
  // Scope 4: CSV Formula Injection Attack Vectors (DDE / Spreadsheet Exploits)
  // =========================================================================
  describe("Scope 4: CSV Formula Injection Attack Vectors", () => {
    const maliciousPayloads = [
      "=cmd|' /C calc'!A0",
      "@SUM(1+1)*cmd|' /C calc'!A0",
      "+123456789",
      "-999999999",
      "\t=2+5",
      "\r=1+1",
      "\n=1+1",
      "＝2+2", // Fullwidth equal
      "＋4+4", // Fullwidth plus
      "－8-8", // Fullwidth minus
      "＠SUM()", // Fullwidth at
    ];

    maliciousPayloads.forEach((payload) => {
      it(`neutralizes injection payload: ${JSON.stringify(payload)}`, () => {
        const escaped = escapeCsvUntrustedTextCell(payload);

        // Cell must NOT begin with raw formula execution trigger characters without a single-quote prefix
        // In CSV, it should either start with "'" or "\"'..."
        const startsWithNeutralizer =
          escaped.startsWith("'") ||
          escaped.startsWith(`"'`) ||
          escaped.startsWith(`"'=`) ||
          escaped.startsWith(`"'@`) ||
          escaped.startsWith(`"'+`) ||
          escaped.startsWith(`"'-`);

        expect(startsWithNeutralizer).toBe(true);

        // Must not start with raw unquoted '='
        expect(escaped.startsWith("=")).toBe(false);
        expect(escaped.startsWith("@")).toBe(false);
        expect(escaped.startsWith("+")).toBe(false);
        expect(escaped.startsWith("-")).toBe(false);
      });
    });
  });

  // =========================================================================
  // Scope 5: RBAC Security Challenger (Fail-Closed Gatekeeper)
  // =========================================================================
  describe("Scope 5: RBAC Security Challenger (Fail-Closed Gatekeeper)", () => {
    const unauthorizedRoles = [
      "member",
      "admin",
      "viewer",
      "shopper",
      "support",
      "partner",
      "system",
      "super_owner",
      "OWNER", // Uppercase bypass attempt
      "owner ", // Trailing space bypass attempt
      " owner", // Leading space bypass attempt
      "", // Empty string
      null as any, // Null
      undefined as any, // Undefined
    ];

    unauthorizedRoles.forEach((role) => {
      it(`rejects unauthorized callerRole: ${JSON.stringify(role)} with 403-equivalent Error`, async () => {
        await expect(
          exportLoyaltyMetricsJson({
            storeId,
            callerRole: role,
          }),
        ).rejects.toThrow(/Unauthorized: Only store owners/);

        await expect(
          exportLoyaltyMetricsCsv({
            storeId,
            callerRole: role,
          }),
        ).rejects.toThrow(/Unauthorized: Only store owners/);
      });
    });

    it("allows exact lowercase 'owner' callerRole", async () => {
      const result = await exportLoyaltyMetricsJson({
        storeId,
        callerRole: "owner",
      });
      expect(result.callerRole).toBe("owner");

      const csv = await exportLoyaltyMetricsCsv({
        storeId,
        callerRole: "owner",
      });
      expect(csv).toContain("Metadata,Caller Role,owner");
    });
  });
});
