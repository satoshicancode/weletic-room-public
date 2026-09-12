import type { ResolvedShopifyCredentials } from "@/lib/weletic/loyalty/shopify-discounts";
import {
  assertFinancialRewardScope,
  createShopifyGiftCard,
  createShopifyStoreCredit,
  deactivateShopifyGiftCard,
  debitShopifyStoreCredit,
  lookupShopifyGiftCard,
  lookupShopifyStoreCreditAccount,
  ShopifyFinancialRewardError,
} from "@/lib/weletic/loyalty/shopify-financial-rewards";
import { describe, expect, it, vi } from "vitest";

const credentials: ResolvedShopifyCredentials = {
  shopDomain: "financial-test.myshopify.com",
  accessToken: "offline-token",
  scope:
    "read_gift_cards,write_gift_cards,write_customers,read_store_credit_accounts,write_store_credit_account_transactions",
  source: "app_session",
};

function graphqlResponse(data: Record<string, unknown>) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function giftCardNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/GiftCard/101",
    enabled: true,
    expiresOn: null,
    initialValue: { amount: "25.00", currencyCode: "USD" },
    customer: { id: "gid://shopify/Customer/77" },
    lastCharacters: "CD12",
    maskedCode: "•••• •••• •••• CD12",
    note: "Weletic loyalty redemption wredemp_1",
    ...overrides,
  };
}

describe("Shopify financial loyalty rewards", () => {
  it.each([undefined, "", " \t\n", ", ,"])(
    "rejects unavailable scope evidence (%s) before issuance or recovery requests",
    async (scope) => {
      const customFetch = vi.fn();
      const unverified = { ...credentials, scope };
      for (const rewardType of ["gift_card", "store_credit"] as const) {
        expect(() =>
          assertFinancialRewardScope({ credentials: unverified, rewardType }),
        ).toThrowError(expect.objectContaining({ code: "MISSING_SCOPE" }));
      }
      await expect(
        createShopifyGiftCard({
          credentials: unverified,
          code: "WLGCABCD1234CD12",
          customerId: "77",
          amountMinor: BigInt(2500),
          currencyCode: "USD",
          expiresAt: null,
          note: "Synthetic scope rejection",
          customFetch,
        }),
      ).rejects.toMatchObject({ code: "MISSING_SCOPE" });
      await expect(
        createShopifyStoreCredit({
          credentials: unverified,
          customerId: "77",
          amountMinor: BigInt(1000),
          currencyCode: "USD",
          expiresAt: null,
          notify: false,
          customFetch,
        }),
      ).rejects.toMatchObject({ code: "MISSING_SCOPE" });
      await expect(
        deactivateShopifyGiftCard({
          credentials: unverified,
          giftCardId: "101",
          customFetch,
        }),
      ).rejects.toMatchObject({ code: "MISSING_SCOPE" });
      await expect(
        lookupShopifyStoreCreditAccount({
          credentials: unverified,
          accountId: "201",
          customFetch,
        }),
      ).rejects.toMatchObject({ code: "MISSING_SCOPE" });
      await expect(
        debitShopifyStoreCredit({
          credentials: unverified,
          accountId: "201",
          amountMinor: BigInt(1000),
          currencyCode: "USD",
          customFetch,
        }),
      ).rejects.toMatchObject({ code: "MISSING_SCOPE" });
      expect(customFetch).not.toHaveBeenCalled();
    },
  );

  it("accepts a write scope as the stronger equivalent of its read scope", () => {
    expect(() =>
      assertFinancialRewardScope({
        credentials: {
          ...credentials,
          scope:
            "write_gift_cards,write_customers,write_store_credit_account_transactions",
        },
        rewardType: "gift_card",
      }),
    ).not.toThrow();
  });

  it("fails before mutation when an installation lacks financial scopes", () => {
    expect(() =>
      assertFinancialRewardScope({
        credentials: { ...credentials, scope: "read_customers" },
        rewardType: "gift_card",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ShopifyFinancialRewardError>>({
        code: "MISSING_SCOPE",
      }),
    );
  });

  it("creates an exact customer-bound gift card in store currency", async () => {
    const customFetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.variables.input).toEqual({
        code: "WLGCABCD1234CD12",
        initialAmount: { amount: "25.00", currencyCode: "USD" },
        customerId: "gid://shopify/Customer/77",
        expiresOn: null,
        note: "Weletic loyalty redemption wredemp_1",
      });
      return graphqlResponse({
        giftCardCreate: {
          giftCard: giftCardNode(),
          giftCardCode: "WLGCABCD1234CD12",
          userErrors: [],
        },
      });
    });

    const result = await createShopifyGiftCard({
      credentials,
      code: "wlgcabcd1234cd12",
      customerId: "77",
      amountMinor: BigInt(2500),
      currencyCode: "USD",
      expiresAt: null,
      note: "Weletic loyalty redemption wredemp_1",
      customFetch,
    });

    expect(result).toMatchObject({
      id: "gid://shopify/GiftCard/101",
      code: "WLGCABCD1234CD12",
    });
    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it("adopts only an exact gift-card match after an ambiguous create", async () => {
    const customFetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.variables.query).toBe("WLGCABCD1234CD12");
      return graphqlResponse({ giftCards: { nodes: [giftCardNode()] } });
    });

    const result = await lookupShopifyGiftCard({
      shopDomain: credentials.shopDomain,
      accessToken: credentials.accessToken,
      code: "WLGCABCD1234CD12",
      customerId: "77",
      amountMinor: BigInt(2500),
      currencyCode: "USD",
      expiresAt: null,
      note: "Weletic loyalty redemption wredemp_1",
      customFetch,
    });

    expect(result?.id).toBe("gid://shopify/GiftCard/101");
  });

  it("issues store credit once and validates the returned economics", async () => {
    const customFetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.variables).toEqual({
        id: "gid://shopify/Customer/77",
        creditInput: {
          creditAmount: { amount: "10.00", currencyCode: "USD" },
          expiresAt: null,
          notify: true,
        },
      });
      return graphqlResponse({
        storeCreditAccountCredit: {
          storeCreditAccountTransaction: {
            id: "gid://shopify/StoreCreditAccountTransaction/501",
            amount: { amount: "10.00", currencyCode: "USD" },
            account: { id: "gid://shopify/StoreCreditAccount/9" },
          },
          userErrors: [],
        },
      });
    });

    await expect(
      createShopifyStoreCredit({
        credentials,
        customerId: "77",
        amountMinor: BigInt(1000),
        currencyCode: "USD",
        expiresAt: null,
        notify: true,
        customFetch,
      }),
    ).resolves.toEqual({
      transactionId: "gid://shopify/StoreCreditAccountTransaction/501",
      accountId: "gid://shopify/StoreCreditAccount/9",
      amount: "10.00",
      currencyCode: "USD",
    });
    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it("reads and debits an exact Store Credit account without replaying the mutation", async () => {
    const customFetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("query WeleticStoreCreditAccount")) {
        expect(body.variables).toEqual({
          id: "gid://shopify/StoreCreditAccount/9",
        });
        return graphqlResponse({
          storeCreditAccount: {
            id: "gid://shopify/StoreCreditAccount/9",
            balance: { amount: "10.00", currencyCode: "USD" },
          },
        });
      }
      expect(body.variables).toEqual({
        id: "gid://shopify/StoreCreditAccount/9",
        debitInput: {
          debitAmount: { amount: "10.00", currencyCode: "USD" },
        },
      });
      return graphqlResponse({
        storeCreditAccountDebit: {
          storeCreditAccountTransaction: {
            id: "gid://shopify/StoreCreditAccountDebitTransaction/601",
            amount: { amount: "-10.00", currencyCode: "USD" },
            account: {
              id: "gid://shopify/StoreCreditAccount/9",
              balance: { amount: "0.00", currencyCode: "USD" },
            },
          },
          userErrors: [],
        },
      });
    });

    await expect(
      lookupShopifyStoreCreditAccount({
        credentials,
        accountId: "9",
        customFetch,
      }),
    ).resolves.toEqual({
      accountId: "gid://shopify/StoreCreditAccount/9",
      balance: "10.00",
      currencyCode: "USD",
    });
    await expect(
      debitShopifyStoreCredit({
        credentials,
        accountId: "9",
        amountMinor: BigInt(1000),
        currencyCode: "USD",
        customFetch,
      }),
    ).resolves.toMatchObject({
      accountId: "gid://shopify/StoreCreditAccount/9",
      amount: "-10.00",
      balanceAfter: "0.00",
    });
    expect(customFetch).toHaveBeenCalledTimes(2);
  });

  it("classifies a lost Store Credit debit response as unknown and never retries", async () => {
    const customFetch = vi.fn(async () => {
      throw new Error("socket closed after debit dispatch");
    });

    await expect(
      debitShopifyStoreCredit({
        credentials,
        accountId: "9",
        amountMinor: BigInt(1000),
        currencyCode: "USD",
        customFetch,
      }),
    ).rejects.toMatchObject({ code: "REMOTE_OUTCOME_UNKNOWN" });
    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it("classifies a lost store-credit response as unknown and never retries", async () => {
    const customFetch = vi.fn(async () => {
      throw new Error("socket closed after dispatch");
    });

    await expect(
      createShopifyStoreCredit({
        credentials,
        customerId: "77",
        amountMinor: BigInt(1000),
        currencyCode: "USD",
        expiresAt: null,
        notify: true,
        customFetch,
      }),
    ).rejects.toMatchObject({ code: "REMOTE_OUTCOME_UNKNOWN" });
    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it("treats a partial store-credit payload as ambiguous financial state", async () => {
    const customFetch = vi.fn(async () =>
      graphqlResponse({
        storeCreditAccountCredit: {
          storeCreditAccountTransaction: {
            id: "gid://shopify/StoreCreditAccountTransaction/partial",
            amount: { amount: "10.00", currencyCode: "USD" },
            account: { id: "gid://shopify/StoreCreditAccount/9" },
          },
          userErrors: [{ message: "Unexpected partial result" }],
        },
      }),
    );

    await expect(
      createShopifyStoreCredit({
        credentials,
        customerId: "77",
        amountMinor: BigInt(1000),
        currencyCode: "USD",
        expiresAt: null,
        notify: false,
        customFetch,
      }),
    ).rejects.toMatchObject({ code: "REMOTE_CONFIGURATION_MISMATCH" });
  });
});
