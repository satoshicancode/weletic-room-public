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
  it.each([
    ["empty lookup", []],
    [
      "wrong customer",
      [giftCardNode({ customer: { id: "gid://shopify/Customer/88" } })],
    ],
    [
      "wrong amount",
      [
        giftCardNode({
          initialValue: { amount: "26.00", currencyCode: "USD" },
        }),
      ],
    ],
    ["disabled artifact", [giftCardNode({ enabled: false })]],
  ])(
    "retains ambiguous issuance after duplicate code and %s",
    async (_name, nodes) => {
      const customFetch = vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return body.query.includes("mutation")
          ? graphqlResponse({
              giftCardCreate: {
                giftCard: null,
                giftCardCode: null,
                userErrors: [
                  { code: "TAKEN", message: "Code has already been taken" },
                ],
              },
            })
          : graphqlResponse({ giftCards: { nodes } });
      });
      await expect(
        createShopifyGiftCard({
          credentials,
          code: "WLGCABCD1234CD12",
          customerId: "77",
          amountMinor: BigInt(2500),
          currencyCode: "USD",
          expiresAt: null,
          note: "Weletic loyalty redemption wredemp_1",
          customFetch,
        }),
      ).rejects.toMatchObject({ code: "REMOTE_OUTCOME_UNKNOWN" });
      expect(customFetch).toHaveBeenCalledTimes(2);
      expect(
        customFetch.mock.calls.filter(([, init]) =>
          JSON.parse(String(init?.body)).query.includes("mutation"),
        ),
      ).toHaveLength(1);
    },
  );

  it("adopts an exact gift card after a duplicate-code response without repeating issuance", async () => {
    const customFetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return body.query.includes("mutation")
        ? graphqlResponse({
            giftCardCreate: {
              giftCard: null,
              giftCardCode: null,
              userErrors: [
                { code: "TAKEN", message: "Code has already been taken" },
              ],
            },
          })
        : graphqlResponse({ giftCards: { nodes: [giftCardNode()] } });
    });
    await expect(
      createShopifyGiftCard({
        credentials,
        code: "WLGCABCD1234CD12",
        customerId: "77",
        amountMinor: BigInt(2500),
        currencyCode: "USD",
        expiresAt: null,
        note: "Weletic loyalty redemption wredemp_1",
        customFetch,
      }),
    ).resolves.toMatchObject({ id: "gid://shopify/GiftCard/101" });
    expect(customFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["unauthorized", "UNAUTHORIZED"],
    ["graphql", "GRAPHQL_USER_ERROR"],
    ["network", "REMOTE_OUTCOME_UNKNOWN"],
    ["multiple matches", "REMOTE_CONFIGURATION_MISMATCH"],
  ])(
    "does not classify duplicate lookup %s as safe to compensate",
    async (failure, code) => {
      const customFetch = vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.query.includes("mutation"))
          return graphqlResponse({
            giftCardCreate: {
              giftCard: null,
              giftCardCode: null,
              userErrors: [
                { code: "TAKEN", message: "Code has already been taken" },
              ],
            },
          });
        if (failure === "unauthorized")
          return new Response(null, { status: 401 });
        if (failure === "graphql")
          return new Response(
            JSON.stringify({
              errors: [
                {
                  message: "Lookup denied",
                  extensions: { code: "ACCESS_DENIED" },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        if (failure === "network")
          throw new Error("Lookup network unavailable");
        return graphqlResponse({
          giftCards: {
            nodes: [
              giftCardNode(),
              giftCardNode({ id: "gid://shopify/GiftCard/102" }),
            ],
          },
        });
      });
      const error = await createShopifyGiftCard({
        credentials,
        code: "WLGCABCD1234CD12",
        customerId: "77",
        amountMinor: BigInt(2500),
        currencyCode: "USD",
        expiresAt: null,
        note: "Weletic loyalty redemption wredemp_1",
        customFetch,
      }).then(
        () => {
          throw new Error("Unexpected successful issuance");
        },
        (error: unknown) => error,
      );
      expect(error).toMatchObject({ code });
      // The saga may restore points only for these financial-adapter errors;
      // a lookup's top-level GraphQL error is not a mutation rejection.
      expect(
        error instanceof ShopifyFinancialRewardError &&
          ["MISSING_SCOPE", "INVALID_REQUEST", "GRAPHQL_USER_ERROR"].includes(
            error.code,
          ),
      ).toBe(false);
      expect(
        customFetch.mock.calls.filter(([, init]) =>
          JSON.parse(String(init?.body)).query.includes("mutation"),
        ),
      ).toHaveLength(1);
      expect(customFetch).toHaveBeenCalledTimes(failure === "network" ? 3 : 2);
    },
  );

  it.each(["credit", "debit"] as const)(
    "rejects wrong-sign %s evidence",
    async (operation) => {
      const customFetch = vi.fn(async () =>
        graphqlResponse({
          [operation === "credit"
            ? "storeCreditAccountCredit"
            : "storeCreditAccountDebit"]: {
            storeCreditAccountTransaction: {
              id: `gid://shopify/${operation === "debit" ? "StoreCreditAccountDebitTransaction" : "StoreCreditAccountTransaction"}/501`,
              amount: {
                amount: operation === "credit" ? "-25.00" : "25.00",
                currencyCode: "USD",
              },
              account: {
                id: "gid://shopify/StoreCreditAccount/9",
                balance: { amount: "0.00", currencyCode: "USD" },
              },
            },
            userErrors: [],
          },
        }),
      );
      const common = {
        credentials,
        amountMinor: BigInt(2500),
        currencyCode: "USD",
        customFetch,
      };
      const result =
        operation === "credit"
          ? createShopifyStoreCredit({
              ...common,
              customerId: "77",
              expiresAt: null,
              notify: false,
            })
          : debitShopifyStoreCredit({ ...common, accountId: "9" });
      await expect(result).rejects.toMatchObject({
        code: "REMOTE_CONFIGURATION_MISMATCH",
      });
      expect(customFetch).toHaveBeenCalledTimes(1);
    },
  );

  describe.each(["gift_card", "credit", "debit"] as const)(
    "exact %s amount evidence",
    (operation) => {
      it.each([
        ["USD trailing zeros", "USD", "2500", "25.0000", true],
        ["JPY trailing zeros", "JPY", "25", "25.00", true],
        ["KWD trailing zeros", "KWD", "25001", "25.001000", true],
        [
          "large exact amount",
          "USD",
          "9007199254740993",
          "90071992547409.9300",
          true,
        ],
        [
          "large adjacent amount",
          "USD",
          "9007199254740993",
          "90071992547409.94",
          false,
        ],
        [
          "JPY unsafe adjacent integer",
          "JPY",
          "9007199254740992",
          "9007199254740993",
          false,
        ],
        ["subminor discrepancy", "USD", "2500", "25.0000001", false],
        ["KWD smallest unit discrepancy", "KWD", "25001", "25.002", false],
        ["exponent notation", "USD", "2500", "2.5e1", false],
        ["hex notation", "USD", "2500", "0x19", false],
        ["leading whitespace", "USD", "2500", " 25.00", false],
        ["nonfinite", "USD", "2500", "Infinity", false],
        ["empty", "USD", "2500", "", false],
      ] as const)(
        "validates %s without floating-point tolerance",
        async (_name, currencyCode, minor, remoteAmount, accepted) => {
          const amount =
            operation === "debit" ? `-${remoteAmount}` : remoteAmount;
          const customFetch = vi.fn(async () => {
            if (operation === "gift_card")
              return graphqlResponse({
                giftCardCreate: {
                  giftCard: giftCardNode({
                    initialValue: { amount, currencyCode },
                  }),
                  giftCardCode: "WLGCABCD1234CD12",
                  userErrors: [],
                },
              });
            const transaction = {
              id: `gid://shopify/${operation === "debit" ? "StoreCreditAccountDebitTransaction" : "StoreCreditAccountTransaction"}/501`,
              amount: { amount, currencyCode },
              account: {
                id: "gid://shopify/StoreCreditAccount/9",
                balance: { amount: "0", currencyCode },
              },
            };
            return graphqlResponse({
              [operation === "debit"
                ? "storeCreditAccountDebit"
                : "storeCreditAccountCredit"]: {
                storeCreditAccountTransaction: transaction,
                userErrors: [],
              },
            });
          });
          const common = {
            credentials,
            amountMinor: BigInt(minor),
            currencyCode,
            customFetch,
          };
          const result =
            operation === "gift_card"
              ? createShopifyGiftCard({
                  ...common,
                  code: "WLGCABCD1234CD12",
                  customerId: "77",
                  expiresAt: null,
                  note: "Weletic loyalty redemption wredemp_1",
                })
              : operation === "debit"
                ? debitShopifyStoreCredit({ ...common, accountId: "9" })
                : createShopifyStoreCredit({
                    ...common,
                    customerId: "77",
                    expiresAt: null,
                    notify: false,
                  });
          if (accepted) await expect(result).resolves.toBeDefined();
          else
            await expect(result).rejects.toMatchObject({
              code: "REMOTE_CONFIGURATION_MISMATCH",
            });
          expect(customFetch).toHaveBeenCalledTimes(1);
        },
      );
    },
  );

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
