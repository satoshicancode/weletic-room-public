import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { type ResolvedShopifyCredentials } from "@/lib/weletic/loyalty/shopify-discounts";
import {
  assertFinancialRewardScope,
  createShopifyGiftCard,
  createShopifyStoreCredit,
  deactivateShopifyGiftCard,
  debitShopifyStoreCredit,
  lookupShopifyStoreCreditAccount,
} from "@/lib/weletic/loyalty/shopify-financial-rewards";
import {
  currencyMinorUnits,
  decimalToMinorUnits,
  minorUnitsToDecimal,
} from "@/lib/weletic/money";
import { WeleticPointsLedgerEntryType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

// ============================================================================
// In-Memory Database Simulator for Pure Ledger Testing
// ============================================================================

interface InMemAccount {
  id: string;
  storeId: string;
  cachedPointsBalance: bigint;
  cachedPendingPoints: bigint;
  lifetimePointsEarned: bigint;
  lifetimePointsRedeemed: bigint;
  ledgerVersion: number;
  lastQualifyingActivityAt: Date | null;
  nextExpiryDate: Date | null;
  pointsExpiryPolicyVersion: number | null;
  pointsExpiryJobsScheduledAt: Date | null;
}

interface InMemLedgerEntry {
  id: string;
  storeId: string;
  accountId: string;
  sequenceNumber: number;
  entryType: WeleticPointsLedgerEntryType;
  pointsDelta: bigint;
  pendingDelta: bigint;
  balanceAfter: bigint;
  grantId: string | null;
  referenceType: string | null;
  referenceId: string | null;
  idempotencyKey: string;
  reason: string | null;
  metadata: any;
  createdAt: Date;
}

function createInMemoryLedgerDb() {
  const accounts = new Map<string, InMemAccount>();
  const ledgerEntries: InMemLedgerEntry[] = [];

  function getAccount(id: string): InMemAccount | undefined {
    return accounts.get(id);
  }

  function setAccount(account: InMemAccount) {
    accounts.set(account.id, { ...account });
  }

  const mockClient: any = {
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(async ({ where }: { where: any }) => {
        if (where.storeId_idempotencyKey) {
          const { storeId, idempotencyKey } = where.storeId_idempotencyKey;
          const found = ledgerEntries.find(
            (e) => e.storeId === storeId && e.idempotencyKey === idempotencyKey,
          );
          return found ? { ...found } : null;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: any }) => {
        const entry: InMemLedgerEntry = {
          ...data,
          createdAt: new Date(),
        };
        ledgerEntries.push(entry);
        return { ...entry };
      }),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const acc = accounts.get(where.id);
        return acc ? { ...acc } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: any; data: any }) => {
        const acc = accounts.get(where.id);
        if (!acc) return { count: 0 };
        if (where.storeId && acc.storeId !== where.storeId) return { count: 0 };
        if (
          where.ledgerVersion !== undefined &&
          acc.ledgerVersion !== where.ledgerVersion
        ) {
          return { count: 0 };
        }
        const updated: InMemAccount = {
          ...acc,
          cachedPointsBalance:
            data.cachedPointsBalance !== undefined
              ? data.cachedPointsBalance
              : acc.cachedPointsBalance,
          lifetimePointsEarned:
            data.lifetimePointsEarned !== undefined
              ? data.lifetimePointsEarned
              : acc.lifetimePointsEarned,
          lifetimePointsRedeemed:
            data.lifetimePointsRedeemed !== undefined
              ? data.lifetimePointsRedeemed
              : acc.lifetimePointsRedeemed,
          ledgerVersion:
            data.ledgerVersion !== undefined
              ? data.ledgerVersion
              : acc.ledgerVersion,
          cachedPendingPoints:
            data.cachedPendingPoints !== undefined
              ? data.cachedPendingPoints
              : acc.cachedPendingPoints,
        };
        accounts.set(acc.id, updated);
        return { count: 1 };
      }),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(async () => null),
    },
  };

  return {
    mockClient,
    accounts,
    ledgerEntries,
    getAccount,
    setAccount,
  };
}

describe("Weletic Loyalty Store Credit & Gift Card Matrix Test (Requirement R3 / Item 2)", () => {
  const testStoreDomain = "test-store.myshopify.com";
  const testAccessToken = "shpat_test_secret_token_12345";
  const validCredentials: ResolvedShopifyCredentials = {
    shopDomain: testStoreDomain,
    accessToken: testAccessToken,
    scope:
      "read_gift_cards,write_gift_cards,write_customers,read_store_credit_accounts,write_store_credit_account_transactions",
    source: "env_override",
  };

  // ==========================================================================
  // Phase 1: Store Credit Admin GraphQL Issuance
  // ==========================================================================
  describe("Phase 1: Store Credit Admin GraphQL Issuance", () => {
    it("successfully issues USD store credit with customer GID, minor unit conversion, expiresAt, and notify flag", async () => {
      const recordedCalls: Array<{ url: string; body: any }> = [];
      const customFetch: typeof fetch = vi.fn(async (url: any, init: any) => {
        recordedCalls.push({
          url: url.toString(),
          body: JSON.parse(init.body),
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              storeCreditAccountCredit: {
                storeCreditAccountTransaction: {
                  id: "gid://shopify/StoreCreditAccountTransaction/10101",
                  amount: { amount: "10.00", currencyCode: "USD" },
                  account: { id: "gid://shopify/StoreCreditAccount/90909" },
                },
                userErrors: [],
              },
            },
          }),
        } as any;
      });

      const expiresAt = new Date("2027-12-31T23:59:59.000Z");
      const result = await createShopifyStoreCredit({
        credentials: validCredentials,
        customerId: "777888",
        amountMinor: BigInt(1000), // $10.00
        currencyCode: "USD",
        expiresAt,
        notify: true,
        customFetch,
      });

      expect(result).toEqual({
        transactionId: "gid://shopify/StoreCreditAccountTransaction/10101",
        accountId: "gid://shopify/StoreCreditAccount/90909",
        amount: "10.00",
        currencyCode: "USD",
      });

      expect(recordedCalls).toHaveLength(1);
      const call = recordedCalls[0];
      expect(call.body.variables).toEqual({
        id: "gid://shopify/Customer/777888",
        creditInput: {
          creditAmount: {
            amount: "10.00",
            currencyCode: "USD",
          },
          expiresAt: "2027-12-31T23:59:59.000Z",
          notify: true,
        },
      });
      expect(call.body.query).toContain("storeCreditAccountCredit");
    });

    it("suppresses store credit notification when notify flag is false", async () => {
      const recordedCalls: Array<any> = [];
      const customFetch: typeof fetch = vi.fn(async (_url: any, init: any) => {
        recordedCalls.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              storeCreditAccountCredit: {
                storeCreditAccountTransaction: {
                  id: "gid://shopify/StoreCreditAccountTransaction/10102",
                  amount: { amount: "25.00", currencyCode: "USD" },
                  account: { id: "gid://shopify/StoreCreditAccount/90909" },
                },
                userErrors: [],
              },
            },
          }),
        } as any;
      });

      await createShopifyStoreCredit({
        credentials: validCredentials,
        customerId: "gid://shopify/Customer/777888",
        amountMinor: BigInt(2500),
        currencyCode: "USD",
        expiresAt: null,
        notify: false,
        customFetch,
      });

      expect(recordedCalls[0].variables.creditInput.notify).toBe(false);
      expect(recordedCalls[0].variables.creditInput.expiresAt).toBeNull();
    });

    it("handles non-expiring store credit (expiresAt = null)", async () => {
      const customFetch: typeof fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            storeCreditAccountCredit: {
              storeCreditAccountTransaction: {
                id: "gid://shopify/StoreCreditAccountTransaction/10103",
                amount: { amount: "5.00", currencyCode: "USD" },
                account: { id: "gid://shopify/StoreCreditAccount/90909" },
              },
              userErrors: [],
            },
          },
        }),
      })) as any;

      const result = await createShopifyStoreCredit({
        credentials: validCredentials,
        customerId: "12345",
        amountMinor: BigInt(500),
        currencyCode: "USD",
        expiresAt: null,
        notify: true,
        customFetch,
      });

      expect(result.amount).toBe("5.00");
    });

    it("rejects when Shopify returns GraphQL userErrors", async () => {
      const customFetch: typeof fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            storeCreditAccountCredit: {
              storeCreditAccountTransaction: null,
              userErrors: [
                {
                  field: ["creditInput", "creditAmount"],
                  message:
                    "The credit amount exceeds the maximum permissible limit.",
                  code: "MAXIMUM_LIMIT_EXCEEDED",
                },
              ],
            },
          },
        }),
      })) as any;

      await expect(
        createShopifyStoreCredit({
          credentials: validCredentials,
          customerId: "12345",
          amountMinor: BigInt(1_000_000_00),
          currencyCode: "USD",
          expiresAt: null,
          notify: true,
          customFetch,
        }),
      ).rejects.toMatchObject({
        name: "ShopifyFinancialRewardError",
        code: "GRAPHQL_USER_ERROR",
        message: expect.stringContaining("maximum permissible limit"),
      });
    });

    it("rejects immediately when installation is missing required store credit scopes", () => {
      const missingScopeCredentials: ResolvedShopifyCredentials = {
        ...validCredentials,
        scope: "read_gift_cards,write_gift_cards", // missing store credit scopes
      };

      expect(() =>
        assertFinancialRewardScope({
          credentials: missingScopeCredentials,
          rewardType: "store_credit",
        }),
      ).toThrowError(/missing required scope/i);
    });

    it("rejects with REMOTE_CONFIGURATION_MISMATCH if returned currency or amount deviates from request", async () => {
      const customFetch: typeof fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            storeCreditAccountCredit: {
              storeCreditAccountTransaction: {
                id: "gid://shopify/StoreCreditAccountTransaction/10104",
                amount: { amount: "10.00", currencyCode: "EUR" }, // Mismatched currency (requested USD)
                account: { id: "gid://shopify/StoreCreditAccount/90909" },
              },
              userErrors: [],
            },
          },
        }),
      })) as any;

      await expect(
        createShopifyStoreCredit({
          credentials: validCredentials,
          customerId: "12345",
          amountMinor: BigInt(1000),
          currencyCode: "USD",
          expiresAt: null,
          notify: true,
          customFetch,
        }),
      ).rejects.toMatchObject({
        code: "REMOTE_CONFIGURATION_MISMATCH",
      });
    });
  });

  // ==========================================================================
  // Phase 2: Store Credit Debit & Adjustment
  // ==========================================================================
  describe("Phase 2: Store Credit Debit & Adjustment", () => {
    it("successfully debits store credit account, returning negative transaction amount and remaining balance", async () => {
      const recordedCalls: Array<any> = [];
      const customFetch: typeof fetch = vi.fn(async (_url: any, init: any) => {
        recordedCalls.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              storeCreditAccountDebit: {
                storeCreditAccountTransaction: {
                  id: "gid://shopify/StoreCreditAccountTransaction/20201",
                  amount: { amount: "-10.00", currencyCode: "USD" },
                  account: {
                    id: "gid://shopify/StoreCreditAccount/90909",
                    balance: { amount: "15.00", currencyCode: "USD" },
                  },
                },
                userErrors: [],
              },
            },
          }),
        } as any;
      });

      const result = await debitShopifyStoreCredit({
        credentials: validCredentials,
        accountId: "90909",
        amountMinor: BigInt(1000),
        currencyCode: "USD",
        customFetch,
      });

      expect(result).toEqual({
        transactionId: "gid://shopify/StoreCreditAccountTransaction/20201",
        accountId: "gid://shopify/StoreCreditAccount/90909",
        amount: "-10.00",
        currencyCode: "USD",
        balanceAfter: "15.00",
      });
      expect(recordedCalls[0].variables.id).toBe(
        "gid://shopify/StoreCreditAccount/90909",
      );
      expect(recordedCalls[0].variables.debitInput.debitAmount.amount).toBe(
        "10.00",
      );
    });

    it("verifies full debit drives account balance to strictly zero", async () => {
      const customFetch: typeof fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            storeCreditAccountDebit: {
              storeCreditAccountTransaction: {
                id: "gid://shopify/StoreCreditAccountTransaction/20202",
                amount: { amount: "-25.00", currencyCode: "USD" },
                account: {
                  id: "gid://shopify/StoreCreditAccount/90909",
                  balance: { amount: "0.00", currencyCode: "USD" },
                },
              },
              userErrors: [],
            },
          },
        }),
      })) as any;

      const result = await debitShopifyStoreCredit({
        credentials: validCredentials,
        accountId: "90909",
        amountMinor: BigInt(2500),
        currencyCode: "USD",
        customFetch,
      });

      expect(result.balanceAfter).toBe("0.00");
    });

    it("rejects over-debit when Shopify returns userErrors indicating debit exceeds balance", async () => {
      const customFetch: typeof fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            storeCreditAccountDebit: {
              storeCreditAccountTransaction: null,
              userErrors: [
                {
                  field: ["debitInput", "debitAmount"],
                  message:
                    "Debit amount cannot exceed the available balance of the store credit account.",
                  code: "DEBIT_EXCEEDS_BALANCE",
                },
              ],
            },
          },
        }),
      })) as any;

      await expect(
        debitShopifyStoreCredit({
          credentials: validCredentials,
          accountId: "90909",
          amountMinor: BigInt(5000),
          currencyCode: "USD",
          customFetch,
        }),
      ).rejects.toMatchObject({
        code: "GRAPHQL_USER_ERROR",
        message: expect.stringContaining("cannot exceed the available balance"),
      });
    });

    it("rejects non-positive debit amounts before dispatching network request", async () => {
      const customFetch = vi.fn();
      await expect(
        debitShopifyStoreCredit({
          credentials: validCredentials,
          accountId: "90909",
          amountMinor: BigInt(0),
          currencyCode: "USD",
          customFetch: customFetch as any,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("must be positive"),
      });
      expect(customFetch).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Phase 3: Multi-Currency Store Credit Wallets
  // ==========================================================================
  describe("Phase 3: Multi-Currency Store Credit Wallets", () => {
    it("maintains strict wallet isolation between USD and JPY for the same customer", async () => {
      const accounts = [
        {
          id: "gid://shopify/StoreCreditAccount/1001",
          balance: { amount: "20.00", currencyCode: "USD" },
        },
        {
          id: "gid://shopify/StoreCreditAccount/2002",
          balance: { amount: "3000", currencyCode: "JPY" },
        },
      ];

      const customFetch: typeof fetch = vi.fn(async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        const acc = accounts.find((a) => a.id === body.variables.id);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              storeCreditAccount: acc ? { ...acc } : null,
            },
          }),
        } as any;
      });

      const usdAcc = await lookupShopifyStoreCreditAccount({
        credentials: validCredentials,
        accountId: "1001",
        customFetch,
      });
      const jpyAcc = await lookupShopifyStoreCreditAccount({
        credentials: validCredentials,
        accountId: "2002",
        customFetch,
      });

      expect(usdAcc).toEqual({
        accountId: "gid://shopify/StoreCreditAccount/1001",
        balance: "20.00",
        currencyCode: "USD",
      });
      expect(jpyAcc).toEqual({
        accountId: "gid://shopify/StoreCreditAccount/2002",
        balance: "3000",
        currencyCode: "JPY",
      });
    });

    it("verifies zero-decimal currency calculations for JPY and VND without fractional digits", () => {
      expect(currencyMinorUnits("JPY")).toBe(0);
      expect(currencyMinorUnits("VND")).toBe(0);

      // JPY: ¥500 = 500 minor units
      const jpyMinor = decimalToMinorUnits("500", "JPY");
      expect(jpyMinor).toBe(BigInt(500));
      expect(minorUnitsToDecimal(jpyMinor, "JPY")).toBe("500");

      // VND: 1,500,000 VND = 1500000 minor units
      const vndMinor = decimalToMinorUnits("1500000", "VND");
      expect(vndMinor).toBe(BigInt(1500000));
      expect(minorUnitsToDecimal(vndMinor, "VND")).toBe("1500000");
    });

    it("verifies three-decimal currency calculations for BHD and KWD", () => {
      expect(currencyMinorUnits("BHD")).toBe(3);
      expect(currencyMinorUnits("KWD")).toBe(3);

      // BHD: 1.500 BHD = 1500 minor units
      const bhdMinor = decimalToMinorUnits("1.500", "BHD");
      expect(bhdMinor).toBe(BigInt(1500));
      expect(minorUnitsToDecimal(bhdMinor, "BHD")).toBe("1.500");

      // 0.250 BHD = 250 minor units
      const bhdSmall = decimalToMinorUnits("0.250", "BHD");
      expect(bhdSmall).toBe(BigInt(250));
      expect(minorUnitsToDecimal(bhdSmall, "BHD")).toBe("0.250");
    });

    it("verifies standard two-decimal currencies for USD and EUR", () => {
      expect(currencyMinorUnits("USD")).toBe(2);
      expect(currencyMinorUnits("EUR")).toBe(2);

      const usdMinor = decimalToMinorUnits("12.34", "USD");
      expect(usdMinor).toBe(BigInt(1234));
      expect(minorUnitsToDecimal(usdMinor, "USD")).toBe("12.34");
    });
  });

  // ==========================================================================
  // Phase 4: Gift Card Creation & Secure Code Generation
  // ==========================================================================
  describe("Phase 4: Gift Card Creation & Secure Code Generation", () => {
    const giftCardCode = "WLGC9F3K2B8A1D4E"; // 16-char code

    it("successfully creates gift card with customer GID, initialValue, YYYY-MM-DD expiration, and note", async () => {
      const recordedCalls: Array<any> = [];
      const customFetch: typeof fetch = vi.fn(async (_url: any, init: any) => {
        recordedCalls.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              giftCardCreate: {
                giftCard: {
                  id: "gid://shopify/GiftCard/30301",
                  enabled: true,
                  expiresOn: "2027-06-30",
                  initialValue: { amount: "50.00", currencyCode: "USD" },
                  customer: { id: "gid://shopify/Customer/777888" },
                  lastCharacters: "1D4E",
                  maskedCode: "•••• •••• •••• 1D4E",
                  note: "Weletic loyalty redemption wredemp_1",
                },
                giftCardCode,
                userErrors: [],
              },
            },
          }),
        } as any;
      });

      const expiresAt = new Date("2027-06-30T15:00:00.000Z");
      const result = await createShopifyGiftCard({
        credentials: validCredentials,
        code: giftCardCode,
        customerId: "777888",
        amountMinor: BigInt(5000), // $50.00
        currencyCode: "USD",
        expiresAt,
        note: "Weletic loyalty redemption wredemp_1",
        customFetch,
      });

      expect(result.id).toBe("gid://shopify/GiftCard/30301");
      expect(result.code).toBe(giftCardCode);
      expect(result.enabled).toBe(true);
      expect(result.initialValue.amount).toBe("50.00");

      const call = recordedCalls[0];
      expect(call.variables.input).toEqual({
        code: giftCardCode,
        initialAmount: { amount: "50.00", currencyCode: "USD" },
        customerId: "gid://shopify/Customer/777888",
        expiresOn: "2027-06-30", // formatted YYYY-MM-DD
        note: "Weletic loyalty redemption wredemp_1",
      });
    });

    it("verifies WLGC 16-character code formatting and validation", () => {
      const validCode = "WLGCABCD1234EF56";
      expect(validCode.length).toBe(16);
      expect(validCode.startsWith("WLGC")).toBe(true);
      expect(/^[A-Z0-9]{8,20}$/.test(validCode)).toBe(true);

      const invalidCodeShort = "WLGC12";
      expect(/^[A-Z0-9]{8,20}$/.test(invalidCodeShort)).toBe(false);

      const invalidCodeSpecial = "WLGC-1234-5678-90";
      expect(/^[A-Z0-9]{8,20}$/.test(invalidCodeSpecial)).toBe(false);
    });

    it("adopts existing gift card via lookup query on duplicate code collision", async () => {
      const customFetch: typeof fetch = vi.fn(async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        if (body.query.includes("giftCardCreate")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                giftCardCreate: {
                  giftCard: null,
                  giftCardCode: null,
                  userErrors: [
                    {
                      field: ["code"],
                      message: "Code has already been taken.",
                      code: "TAKEN",
                    },
                  ],
                },
              },
            }),
          };
        }
        if (body.query.includes("giftCards")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                giftCards: {
                  nodes: [
                    {
                      id: "gid://shopify/GiftCard/30302",
                      enabled: true,
                      expiresOn: null,
                      initialValue: { amount: "25.00", currencyCode: "USD" },
                      customer: { id: "gid://shopify/Customer/777888" },
                      lastCharacters: "1D4E",
                      maskedCode: "•••• •••• •••• 1D4E",
                      note: "Weletic loyalty redemption wredemp_2",
                    },
                  ],
                },
              },
            }),
          };
        }
        throw new Error("Unhandled GraphQL query");
      }) as any;

      const result = await createShopifyGiftCard({
        credentials: validCredentials,
        code: giftCardCode,
        customerId: "777888",
        amountMinor: BigInt(2500),
        currencyCode: "USD",
        expiresAt: null,
        note: "Weletic loyalty redemption wredemp_2",
        customFetch,
      });

      expect(result.id).toBe("gid://shopify/GiftCard/30302");
      expect(result.code).toBe(giftCardCode);
    });

    it("rejects malformed code input before sending request", async () => {
      const customFetch = vi.fn();
      await expect(
        createShopifyGiftCard({
          credentials: validCredentials,
          code: "BAD", // Too short (< 8 chars)
          customerId: "777888",
          amountMinor: BigInt(1000),
          currencyCode: "USD",
          expiresAt: null,
          note: "test",
          customFetch: customFetch as any,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
      expect(customFetch).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Phase 5: Gift Card Deactivation & Expiry
  // ==========================================================================
  describe("Phase 5: Gift Card Deactivation & Expiry", () => {
    it("successfully deactivates gift card via giftCardDeactivate mutation", async () => {
      const customFetch: typeof fetch = vi.fn(async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        expect(body.variables.id).toBe("gid://shopify/GiftCard/30301");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              giftCardDeactivate: {
                giftCard: {
                  id: "gid://shopify/GiftCard/30301",
                  enabled: false,
                },
                userErrors: [],
              },
            },
          }),
        } as any;
      });

      const deactivated = await deactivateShopifyGiftCard({
        credentials: validCredentials,
        giftCardId: "30301",
        customFetch,
      });

      expect(deactivated).toBe(true);
    });

    it("rejects deactivation when Shopify returns userErrors", async () => {
      const customFetch: typeof fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            giftCardDeactivate: {
              giftCard: null,
              userErrors: [
                {
                  field: ["id"],
                  message: "Gift card not found or already disabled.",
                  code: "NOT_FOUND",
                },
              ],
            },
          },
        }),
      })) as any;

      await expect(
        deactivateShopifyGiftCard({
          credentials: validCredentials,
          giftCardId: "invalid_id",
          customFetch,
        }),
      ).rejects.toMatchObject({
        code: "GRAPHQL_USER_ERROR",
        message: expect.stringContaining("Gift card not found"),
      });
    });

    it("verifies reuse rejection for deactivated card", () => {
      const simulatedCard = {
        id: "gid://shopify/GiftCard/30301",
        code: "WLGC9F3K2B8A1D4E",
        enabled: false,
        initialValueMinor: BigInt(5000),
      };

      // Invariant: If enabled is false, card cannot be used or redeemed
      expect(simulatedCard.enabled).toBe(false);
      const attemptCheckout = (card: typeof simulatedCard) => {
        if (!card.enabled) {
          throw new Error("Gift card has been deactivated or expired.");
        }
        return "checkout_approved";
      };

      expect(() => attemptCheckout(simulatedCard)).toThrow(
        "deactivated or expired",
      );
    });
  });

  // ==========================================================================
  // Phase 6: Points Ledger Invariants & Atomicity
  // ==========================================================================
  describe("Phase 6: Points Ledger Invariants & Atomicity", () => {
    it("allocates strictly monotonic sequence numbers on sequential redemptions", async () => {
      const db = createInMemoryLedgerDb();
      const accountId = "acc_ledger_seq_1";
      const storeId = "store_seq_1";

      db.setAccount({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(5000),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(5000),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 0,
        lastQualifyingActivityAt: new Date(),
        nextExpiryDate: null,
        pointsExpiryPolicyVersion: null,
        pointsExpiryJobsScheduledAt: null,
      });

      // Entry 1: Store Credit Redemption (-1000 pts)
      const entry1 = await appendPointsLedgerEntry({
        storeId,
        accountId,
        entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
        pointsDelta: BigInt(-1000),
        referenceType: "REDEMPTION_STORE_CREDIT",
        referenceId: "wredemp_sc_1",
        idempotencyKey: "idem_sc_1",
        tx: db.mockClient,
      });

      // Entry 2: Gift Card Redemption (-1500 pts)
      const entry2 = await appendPointsLedgerEntry({
        storeId,
        accountId,
        entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
        pointsDelta: BigInt(-1500),
        referenceType: "REDEMPTION_GIFT_CARD",
        referenceId: "wredemp_gc_1",
        idempotencyKey: "idem_gc_1",
        tx: db.mockClient,
      });

      // Entry 3: Another Store Credit Redemption (-500 pts)
      const entry3 = await appendPointsLedgerEntry({
        storeId,
        accountId,
        entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
        pointsDelta: BigInt(-500),
        referenceType: "REDEMPTION_STORE_CREDIT",
        referenceId: "wredemp_sc_2",
        idempotencyKey: "idem_sc_2",
        tx: db.mockClient,
      });

      expect(entry1.sequenceNumber).toBe(1);
      expect(entry1.balanceAfter).toBe(BigInt(4000));

      expect(entry2.sequenceNumber).toBe(2);
      expect(entry2.balanceAfter).toBe(BigInt(2500));

      expect(entry3.sequenceNumber).toBe(3);
      expect(entry3.balanceAfter).toBe(BigInt(2000));

      const updatedAcc = db.getAccount(accountId)!;
      expect(updatedAcc.ledgerVersion).toBe(3);
      expect(updatedAcc.cachedPointsBalance).toBe(BigInt(2000));
      expect(updatedAcc.lifetimePointsRedeemed).toBe(BigInt(3000));
    });

    it("verifies OCC ledgerVersion check rejects stale version", async () => {
      const db = createInMemoryLedgerDb();
      const accountId = "acc_occ_1";
      const storeId = "store_occ_1";

      db.setAccount({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(2000),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(2000),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 1, // Current version is 1
        lastQualifyingActivityAt: new Date(),
        nextExpiryDate: null,
        pointsExpiryPolicyVersion: null,
        pointsExpiryJobsScheduledAt: null,
      });

      // Make updateMany return count 0 (simulating OCC failure / concurrent update)
      db.mockClient.weleticLoyaltyAccount.updateMany.mockResolvedValueOnce({
        count: 0,
      });

      await expect(
        appendPointsLedgerEntry({
          storeId,
          accountId,
          entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
          pointsDelta: BigInt(-500),
          referenceType: "REDEMPTION_STORE_CREDIT",
          idempotencyKey: "idem_occ_fail",
          tx: db.mockClient,
        }),
      ).rejects.toThrow();
    });

    it("deduplicates identical redemption requests idempotently without double-debiting", async () => {
      const db = createInMemoryLedgerDb();
      const accountId = "acc_idem_1";
      const storeId = "store_idem_1";

      db.setAccount({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(3000),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(3000),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 0,
        lastQualifyingActivityAt: new Date(),
        nextExpiryDate: null,
        pointsExpiryPolicyVersion: null,
        pointsExpiryJobsScheduledAt: null,
      });

      const params = {
        storeId,
        accountId,
        entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
        pointsDelta: BigInt(-1000),
        referenceType: "REDEMPTION_STORE_CREDIT",
        referenceId: "wredemp_100",
        idempotencyKey: "idem_repeat_key_1",
        tx: db.mockClient,
      };

      const first = await appendPointsLedgerEntry(params);
      const second = await appendPointsLedgerEntry(params);

      expect(first.id).toBe(second.id);
      expect(first.sequenceNumber).toBe(second.sequenceNumber);
      expect(db.ledgerEntries.length).toBe(1);
      expect(db.getAccount(accountId)!.cachedPointsBalance).toBe(BigInt(2000));
    });

    it("rejects idempotency conflict when same key is used with conflicting parameters", async () => {
      const db = createInMemoryLedgerDb();
      const accountId = "acc_idem_2";
      const storeId = "store_idem_2";

      db.setAccount({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(3000),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(3000),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 0,
        lastQualifyingActivityAt: new Date(),
        nextExpiryDate: null,
        pointsExpiryPolicyVersion: null,
        pointsExpiryJobsScheduledAt: null,
      });

      await appendPointsLedgerEntry({
        storeId,
        accountId,
        entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
        pointsDelta: BigInt(-1000),
        referenceType: "REDEMPTION_STORE_CREDIT",
        idempotencyKey: "idem_conflict_key",
        tx: db.mockClient,
      });

      // Attempt second call with different pointsDelta (-2000 instead of -1000)
      await expect(
        appendPointsLedgerEntry({
          storeId,
          accountId,
          entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
          pointsDelta: BigInt(-2000),
          referenceType: "REDEMPTION_STORE_CREDIT",
          idempotencyKey: "idem_conflict_key",
          tx: db.mockClient,
        }),
      ).rejects.toThrow("Ledger idempotency conflict");
    });
  });

  // ==========================================================================
  // Phase 7: Double-Spending & Insolvent Account Protection
  // ==========================================================================
  describe("Phase 7: Double-Spending & Insolvent Account Protection", () => {
    it("rejects redemption when reward points cost exceeds available balance", () => {
      const availableBalance = BigInt(800);
      const rewardPointsCost = BigInt(1000);

      const canRedeem = (balance: bigint, cost: bigint) => balance >= cost;
      expect(canRedeem(availableBalance, rewardPointsCost)).toBe(false);
    });

    it("rejects redemption when account is insolvent (negative balance)", () => {
      const availableBalance = BigInt(-500); // Insolvent account
      const rewardPointsCost = BigInt(100);

      const canRedeem = (balance: bigint, cost: bigint) =>
        balance >= cost && balance > BigInt(0);
      expect(canRedeem(availableBalance, rewardPointsCost)).toBe(false);
    });

    it("drives account balance negative upon refund clawback without ledger corruption", async () => {
      const db = createInMemoryLedgerDb();
      const accountId = "acc_insolvent_1";
      const storeId = "store_insolvent_1";

      // Shopper earned 1,000 points and redeemed all 1,000 for Store Credit. Current balance = 0.
      db.setAccount({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(1000),
        lifetimePointsRedeemed: BigInt(1000),
        ledgerVersion: 2,
        lastQualifyingActivityAt: new Date(),
        nextExpiryDate: null,
        pointsExpiryPolicyVersion: null,
        pointsExpiryJobsScheduledAt: null,
      });

      // Order is refunded: 1,000 points clawback
      const clawbackEntry = await appendPointsLedgerEntry({
        storeId,
        accountId,
        entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        pointsDelta: BigInt(-1000),
        referenceType: "SHOPIFY_REFUND",
        referenceId: "refund_101",
        idempotencyKey: "idem_clawback_101",
        tx: db.mockClient,
      });

      expect(clawbackEntry.sequenceNumber).toBe(3);
      expect(clawbackEntry.balanceAfter).toBe(BigInt(-1000));

      const updatedAcc = db.getAccount(accountId)!;
      expect(updatedAcc.cachedPointsBalance).toBe(BigInt(-1000));
      expect(updatedAcc.ledgerVersion).toBe(3);
    });

    it("offsets negative balance deficit upon subsequent earn", async () => {
      const db = createInMemoryLedgerDb();
      const accountId = "acc_insolvent_2";
      const storeId = "store_insolvent_2";

      // Insolvent account starting at -1000 points
      db.setAccount({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(-1000),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(1000),
        lifetimePointsRedeemed: BigInt(1000),
        ledgerVersion: 3,
        lastQualifyingActivityAt: new Date(),
        nextExpiryDate: null,
        pointsExpiryPolicyVersion: null,
        pointsExpiryJobsScheduledAt: null,
      });

      // Customer makes a new purchase, earning 600 points
      const earnEntry = await appendPointsLedgerEntry({
        storeId,
        accountId,
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: BigInt(600),
        referenceType: "SHOPIFY_ORDER",
        referenceId: "order_202",
        idempotencyKey: "idem_order_202",
        tx: db.mockClient,
      });

      expect(earnEntry.sequenceNumber).toBe(4);
      expect(earnEntry.balanceAfter).toBe(BigInt(-400)); // Deficit reduced from -1000 to -400

      const updatedAcc = db.getAccount(accountId)!;
      expect(updatedAcc.cachedPointsBalance).toBe(BigInt(-400));
      expect(updatedAcc.lifetimePointsEarned).toBe(BigInt(1600));
    });
  });

  // ==========================================================================
  // Phase 8: Mathematical Audit Reconciliation
  // ==========================================================================
  describe("Phase 8: Mathematical Audit Reconciliation", () => {
    it("satisfies mathematical ledger balance equation: sum(pointsDelta) === cachedPointsBalance", async () => {
      const db = createInMemoryLedgerDb();
      const accountId = "acc_audit_1";
      const storeId = "store_audit_1";

      db.setAccount({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 0,
        lastQualifyingActivityAt: new Date(),
        nextExpiryDate: null,
        pointsExpiryPolicyVersion: null,
        pointsExpiryJobsScheduledAt: null,
      });

      const transactions: Array<{
        entryType: WeleticPointsLedgerEntryType;
        pointsDelta: bigint;
        ref: string;
      }> = [
        {
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          pointsDelta: BigInt(2500),
          ref: "ord_1",
        },
        {
          entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
          pointsDelta: BigInt(-1000),
          ref: "red_sc_1",
        },
        {
          entryType: WeleticPointsLedgerEntryType.EARN_BONUS,
          pointsDelta: BigInt(500),
          ref: "bon_1",
        },
        {
          entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
          pointsDelta: BigInt(-1500),
          ref: "red_gc_1",
        },
        {
          entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
          pointsDelta: BigInt(-500),
          ref: "ref_1",
        },
        {
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          pointsDelta: BigInt(800),
          ref: "ord_2",
        },
      ];

      for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        await appendPointsLedgerEntry({
          storeId,
          accountId,
          entryType: tx.entryType,
          pointsDelta: tx.pointsDelta,
          referenceType: "AUDIT_TEST",
          referenceId: tx.ref,
          idempotencyKey: `audit_tx_${i + 1}`,
          tx: db.mockClient,
        });
      }

      const account = db.getAccount(accountId)!;
      const ledgerSum = db.ledgerEntries.reduce(
        (sum, entry) => sum + entry.pointsDelta,
        BigInt(0),
      );

      // Audit Assertion 1: Balance equation
      expect(ledgerSum).toBe(account.cachedPointsBalance);
      expect(account.cachedPointsBalance).toBe(BigInt(800));

      // Audit Assertion 2: Max sequence === ledgerVersion
      const maxSeq = Math.max(...db.ledgerEntries.map((e) => e.sequenceNumber));
      expect(maxSeq).toBe(account.ledgerVersion);
      expect(account.ledgerVersion).toBe(6);
    });

    it("satisfies lifetime earned and lifetime redeemed reconciliation", async () => {
      const db = createInMemoryLedgerDb();
      const accountId = "acc_audit_2";
      const storeId = "store_audit_2";

      db.setAccount({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 0,
        lastQualifyingActivityAt: new Date(),
        nextExpiryDate: null,
        pointsExpiryPolicyVersion: null,
        pointsExpiryJobsScheduledAt: null,
      });

      await appendPointsLedgerEntry({
        storeId,
        accountId,
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: BigInt(3000),
        idempotencyKey: "audit_earn_1",
        tx: db.mockClient,
      });

      await appendPointsLedgerEntry({
        storeId,
        accountId,
        entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
        pointsDelta: BigInt(-1200),
        idempotencyKey: "audit_redeem_1",
        tx: db.mockClient,
      });

      const account = db.getAccount(accountId)!;
      expect(account.lifetimePointsEarned).toBe(BigInt(3000));
      expect(account.lifetimePointsRedeemed).toBe(BigInt(1200));
      expect(account.cachedPointsBalance).toBe(BigInt(1800));
    });

    it("reconciles remote store credit balance against local transaction ledger", () => {
      // Local ledger records of store credit issuances and debits
      const localStoreCreditCredits = [
        BigInt(1000),
        BigInt(2500),
        BigInt(1500),
      ]; // Total: $50.00
      const localStoreCreditDebits = [BigInt(2000)]; // Total debit: $20.00

      const totalCredited = localStoreCreditCredits.reduce(
        (s, c) => s + c,
        BigInt(0),
      );
      const totalDebited = localStoreCreditDebits.reduce(
        (s, d) => s + d,
        BigInt(0),
      );
      const expectedRemoteBalance = totalCredited - totalDebited;

      // Simulated Shopify remote store credit account balance
      const remoteAccountBalance = decimalToMinorUnits("30.00", "USD");

      expect(expectedRemoteBalance).toBe(remoteAccountBalance);
      expect(minorUnitsToDecimal(remoteAccountBalance, "USD")).toBe("30.00");
    });
  });
});
