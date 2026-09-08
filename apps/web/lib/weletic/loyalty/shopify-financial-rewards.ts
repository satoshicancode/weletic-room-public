import {
  formatShopifyGid,
  shopifyAdminGraphqlRequest,
  ShopifyDiscountError,
  type ResolvedShopifyCredentials,
} from "@/lib/weletic/loyalty/shopify-discounts";
import { minorUnitsToDecimal } from "@/lib/weletic/money";

const GIFT_CARD_CODE_PATTERN = /^[A-Z0-9]{8,20}$/;

export class ShopifyFinancialRewardError extends Error {
  constructor(
    public readonly code:
      | "MISSING_SCOPE"
      | "INVALID_REQUEST"
      | "REMOTE_OUTCOME_UNKNOWN"
      | "REMOTE_CONFIGURATION_MISMATCH"
      | "GRAPHQL_USER_ERROR",
    message: string,
    public readonly userErrors?: Array<{
      field?: string[] | string;
      message: string;
      code?: string;
    }>,
  ) {
    super(message);
    this.name = "ShopifyFinancialRewardError";
  }
}

function knownScopes(credentials: ResolvedShopifyCredentials) {
  if (!credentials.scope?.trim()) return null;
  return new Set(
    credentials.scope
      .split(/[ ,]+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
}

function hasFinancialRewardScope(
  scopes: ReadonlySet<string>,
  requiredScope: string,
) {
  if (scopes.has(requiredScope)) return true;
  if (!requiredScope.startsWith("read_")) return false;

  // Shopify can omit a redundant read scope when the corresponding write
  // scope is granted. Treat that stronger grant as satisfying the read check.
  return scopes.has(`write_${requiredScope.slice("read_".length)}`);
}

export function assertFinancialRewardScope({
  credentials,
  rewardType,
}: {
  credentials: ResolvedShopifyCredentials;
  rewardType: "gift_card" | "store_credit";
}) {
  const scopes = knownScopes(credentials);
  if (!scopes) return;
  const required =
    rewardType === "gift_card"
      ? ["read_gift_cards", "write_gift_cards", "write_customers"]
      : [
          "read_store_credit_accounts",
          "write_store_credit_account_transactions",
        ];
  const missing = required.filter(
    (scope) => !hasFinancialRewardScope(scopes, scope),
  );
  if (missing.length > 0) {
    throw new ShopifyFinancialRewardError(
      "MISSING_SCOPE",
      `Shopify installation is missing required scope${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Re-authenticate the Shopify app before enabling this reward.`,
    );
  }
}

type GiftCardNode = {
  id: string;
  enabled: boolean;
  expiresOn: string | null;
  initialValue: { amount: string; currencyCode: string };
  customer: { id: string } | null;
  lastCharacters: string;
  maskedCode: string;
  note: string | null;
};

export type ShopifyGiftCardResult = GiftCardNode & { code: string };

export type ShopifyStoreCreditResult = {
  transactionId: string;
  accountId: string;
  amount: string;
  currencyCode: string;
};

export type ShopifyStoreCreditAccountResult = {
  accountId: string;
  balance: string;
  currencyCode: string;
};

export type ShopifyStoreCreditDebitResult = ShopifyStoreCreditResult & {
  balanceAfter: string;
};

const GIFT_CARD_CREATE_MUTATION = `
mutation WeleticGiftCardCreate($input: GiftCardCreateInput!) {
  giftCardCreate(input: $input) {
    giftCard {
      id
      enabled
      expiresOn
      initialValue { amount currencyCode }
      customer { id }
      lastCharacters
      maskedCode
      note
    }
    giftCardCode
    userErrors { field message code }
  }
}`;

const GIFT_CARD_LOOKUP_QUERY = `
query WeleticGiftCardLookup($query: String!) {
  giftCards(first: 10, query: $query) {
    nodes {
      id
      enabled
      expiresOn
      initialValue { amount currencyCode }
      customer { id }
      lastCharacters
      maskedCode
      note
    }
  }
}`;

const GIFT_CARD_DEACTIVATE_MUTATION = `
mutation WeleticGiftCardDeactivate($id: ID!) {
  giftCardDeactivate(id: $id) {
    giftCard { id enabled }
    userErrors { field message code }
  }
}`;

const STORE_CREDIT_CREATE_MUTATION = `
mutation WeleticStoreCreditCreate(
  $id: ID!
  $creditInput: StoreCreditAccountCreditInput!
) {
  storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
    storeCreditAccountTransaction {
      id
      amount { amount currencyCode }
      account { id }
    }
    userErrors { field message code }
  }
}`;

const STORE_CREDIT_ACCOUNT_QUERY = `
query WeleticStoreCreditAccount($id: ID!) {
  storeCreditAccount(id: $id) {
    id
    balance { amount currencyCode }
  }
}`;

const STORE_CREDIT_DEBIT_MUTATION = `
mutation WeleticStoreCreditDebit(
  $id: ID!
  $debitInput: StoreCreditAccountDebitInput!
) {
  storeCreditAccountDebit(id: $id, debitInput: $debitInput) {
    storeCreditAccountTransaction {
      id
      amount { amount currencyCode }
      account {
        id
        balance { amount currencyCode }
      }
    }
    userErrors { field message code }
  }
}`;

function normalizeDate(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function sameMoney(left: string, right: string) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return (
    Number.isFinite(leftNumber) &&
    Number.isFinite(rightNumber) &&
    Math.abs(leftNumber - rightNumber) < 0.000001
  );
}

function matchesExpectedGiftCard({
  giftCard,
  customerId,
  amount,
  currencyCode,
  expiresOn,
  note,
  code,
}: {
  giftCard: GiftCardNode;
  customerId: string;
  amount: string;
  currencyCode: string;
  expiresOn: Date | null;
  note: string;
  code: string;
}) {
  return (
    giftCard.enabled &&
    giftCard.customer?.id === customerId &&
    giftCard.initialValue.currencyCode === currencyCode &&
    sameMoney(giftCard.initialValue.amount, amount) &&
    giftCard.expiresOn === normalizeDate(expiresOn) &&
    giftCard.note === note &&
    giftCard.lastCharacters.toUpperCase() === code.slice(-4).toUpperCase()
  );
}

function mapTransportError(error: unknown): never {
  if (
    error instanceof ShopifyDiscountError &&
    ["NETWORK_ERROR", "REMOTE_OUTCOME_UNKNOWN", "THROTTLED"].includes(
      error.code,
    )
  ) {
    throw new ShopifyFinancialRewardError(
      "REMOTE_OUTCOME_UNKNOWN",
      error.message,
      error.userErrors,
    );
  }
  throw error;
}

export async function lookupShopifyGiftCard({
  shopDomain,
  accessToken,
  code,
  customerId,
  amountMinor,
  currencyCode,
  expiresAt,
  note,
  customFetch,
}: {
  shopDomain: string;
  accessToken: string;
  code: string;
  customerId: string;
  amountMinor: bigint;
  currencyCode: string;
  expiresAt: Date | null;
  note: string;
  customFetch?: typeof fetch;
}): Promise<ShopifyGiftCardResult | null> {
  const normalizedCode = code.trim().toUpperCase();
  if (!GIFT_CARD_CODE_PATTERN.test(normalizedCode)) {
    throw new ShopifyFinancialRewardError(
      "INVALID_REQUEST",
      "Gift card codes must contain 8 to 20 letters or numbers.",
    );
  }
  const customerGid = formatShopifyGid("Customer", customerId);
  const amount = minorUnitsToDecimal(amountMinor, currencyCode);
  const data = await shopifyAdminGraphqlRequest<{
    giftCards: { nodes: GiftCardNode[] };
  }>({
    shopDomain,
    accessToken,
    query: GIFT_CARD_LOOKUP_QUERY,
    variables: { query: normalizedCode },
    customFetch,
    maxRetries: 1,
  });
  const exact = data.giftCards.nodes.filter((giftCard) =>
    matchesExpectedGiftCard({
      giftCard,
      customerId: customerGid,
      amount,
      currencyCode,
      expiresOn: expiresAt,
      note,
      code: normalizedCode,
    }),
  );
  if (exact.length > 1) {
    throw new ShopifyFinancialRewardError(
      "REMOTE_CONFIGURATION_MISMATCH",
      "Multiple Shopify gift cards match the immutable reward identity.",
    );
  }
  return exact[0] ? { ...exact[0], code: normalizedCode } : null;
}

export async function createShopifyGiftCard({
  credentials,
  code,
  customerId,
  amountMinor,
  currencyCode,
  expiresAt,
  note,
  customFetch,
}: {
  credentials: ResolvedShopifyCredentials;
  code: string;
  customerId: string;
  amountMinor: bigint;
  currencyCode: string;
  expiresAt: Date | null;
  note: string;
  customFetch?: typeof fetch;
}): Promise<ShopifyGiftCardResult> {
  assertFinancialRewardScope({ credentials, rewardType: "gift_card" });
  const normalizedCode = code.trim().toUpperCase();
  if (!GIFT_CARD_CODE_PATTERN.test(normalizedCode)) {
    throw new ShopifyFinancialRewardError(
      "INVALID_REQUEST",
      "Gift card codes must contain 8 to 20 letters or numbers.",
    );
  }
  const customerGid = formatShopifyGid("Customer", customerId);
  const amount = minorUnitsToDecimal(amountMinor, currencyCode);
  try {
    const data = await shopifyAdminGraphqlRequest<{
      giftCardCreate: {
        giftCard: GiftCardNode | null;
        giftCardCode: string | null;
        userErrors: Array<{
          field?: string[] | string;
          message: string;
          code?: string;
        }>;
      };
    }>({
      shopDomain: credentials.shopDomain,
      accessToken: credentials.accessToken,
      query: GIFT_CARD_CREATE_MUTATION,
      variables: {
        input: {
          code: normalizedCode,
          initialAmount: { amount, currencyCode },
          customerId: customerGid,
          expiresOn: normalizeDate(expiresAt),
          note,
        },
      },
      customFetch,
      maxRetries: 0,
      postDispatchOutcomeUnknown: true,
    });
    const payload = data.giftCardCreate;
    if (payload.userErrors.length > 0) {
      if (payload.giftCard || payload.giftCardCode) {
        throw new ShopifyFinancialRewardError(
          "REMOTE_CONFIGURATION_MISMATCH",
          "Shopify returned both a Gift Card artifact and user errors; manual reconciliation is required before points can be restored.",
          payload.userErrors,
        );
      }
      const duplicate = payload.userErrors.some((error) =>
        /taken|already exists|duplicate/i.test(
          `${error.code ?? ""} ${error.message}`,
        ),
      );
      if (duplicate) {
        const existing = await lookupShopifyGiftCard({
          shopDomain: credentials.shopDomain,
          accessToken: credentials.accessToken,
          code: normalizedCode,
          customerId,
          amountMinor,
          currencyCode,
          expiresAt,
          note,
          customFetch,
        });
        if (existing) return existing;
      }
      throw new ShopifyFinancialRewardError(
        "GRAPHQL_USER_ERROR",
        payload.userErrors.map((error) => error.message).join("; "),
        payload.userErrors,
      );
    }
    if (
      !payload.giftCard ||
      payload.giftCardCode?.toUpperCase() !== normalizedCode ||
      !matchesExpectedGiftCard({
        giftCard: payload.giftCard,
        customerId: customerGid,
        amount,
        currencyCode,
        expiresOn: expiresAt,
        note,
        code: normalizedCode,
      })
    ) {
      throw new ShopifyFinancialRewardError(
        "REMOTE_CONFIGURATION_MISMATCH",
        "Shopify created a gift card that does not match the immutable loyalty reward configuration.",
      );
    }
    return { ...payload.giftCard, code: normalizedCode };
  } catch (error) {
    return mapTransportError(error);
  }
}

export async function deactivateShopifyGiftCard({
  credentials,
  giftCardId,
  customFetch,
}: {
  credentials: ResolvedShopifyCredentials;
  giftCardId: string;
  customFetch?: typeof fetch;
}) {
  assertFinancialRewardScope({ credentials, rewardType: "gift_card" });
  const data = await shopifyAdminGraphqlRequest<{
    giftCardDeactivate: {
      giftCard: { id: string; enabled: boolean } | null;
      userErrors: Array<{ message: string; field?: string[]; code?: string }>;
    };
  }>({
    shopDomain: credentials.shopDomain,
    accessToken: credentials.accessToken,
    query: GIFT_CARD_DEACTIVATE_MUTATION,
    variables: { id: formatShopifyGid("GiftCard", giftCardId) },
    customFetch,
    maxRetries: 1,
  });
  if (data.giftCardDeactivate.userErrors.length > 0) {
    throw new ShopifyFinancialRewardError(
      "GRAPHQL_USER_ERROR",
      data.giftCardDeactivate.userErrors
        .map((error) => error.message)
        .join("; "),
      data.giftCardDeactivate.userErrors,
    );
  }
  return Boolean(
    data.giftCardDeactivate.giftCard &&
      !data.giftCardDeactivate.giftCard.enabled,
  );
}

export async function createShopifyStoreCredit({
  credentials,
  customerId,
  amountMinor,
  currencyCode,
  expiresAt,
  notify,
  customFetch,
}: {
  credentials: ResolvedShopifyCredentials;
  customerId: string;
  amountMinor: bigint;
  currencyCode: string;
  expiresAt: Date | null;
  notify: boolean;
  customFetch?: typeof fetch;
}): Promise<ShopifyStoreCreditResult> {
  assertFinancialRewardScope({ credentials, rewardType: "store_credit" });
  try {
    const data = await shopifyAdminGraphqlRequest<{
      storeCreditAccountCredit: {
        storeCreditAccountTransaction: {
          id: string;
          amount: { amount: string; currencyCode: string };
          account: { id: string };
        } | null;
        userErrors: Array<{
          field?: string[] | string;
          message: string;
          code?: string;
        }>;
      };
    }>({
      shopDomain: credentials.shopDomain,
      accessToken: credentials.accessToken,
      query: STORE_CREDIT_CREATE_MUTATION,
      variables: {
        id: formatShopifyGid("Customer", customerId),
        creditInput: {
          creditAmount: {
            amount: minorUnitsToDecimal(amountMinor, currencyCode),
            currencyCode,
          },
          expiresAt: expiresAt?.toISOString() ?? null,
          notify,
        },
      },
      customFetch,
      maxRetries: 0,
      postDispatchOutcomeUnknown: true,
    });
    const payload = data.storeCreditAccountCredit;
    if (payload.userErrors.length > 0) {
      if (payload.storeCreditAccountTransaction) {
        throw new ShopifyFinancialRewardError(
          "REMOTE_CONFIGURATION_MISMATCH",
          "Shopify returned both a Store Credit transaction and user errors; manual reconciliation is required before any retry.",
          payload.userErrors,
        );
      }
      throw new ShopifyFinancialRewardError(
        "GRAPHQL_USER_ERROR",
        payload.userErrors.map((error) => error.message).join("; "),
        payload.userErrors,
      );
    }
    const transaction = payload.storeCreditAccountTransaction;
    if (
      !transaction ||
      transaction.amount.currencyCode !== currencyCode ||
      !sameMoney(
        transaction.amount.amount,
        minorUnitsToDecimal(amountMinor, currencyCode),
      )
    ) {
      throw new ShopifyFinancialRewardError(
        "REMOTE_CONFIGURATION_MISMATCH",
        "Shopify returned a store-credit transaction that does not match the immutable loyalty reward configuration.",
      );
    }
    return {
      transactionId: transaction.id,
      accountId: transaction.account.id,
      amount: transaction.amount.amount,
      currencyCode: transaction.amount.currencyCode,
    };
  } catch (error) {
    return mapTransportError(error);
  }
}

export async function lookupShopifyStoreCreditAccount({
  credentials,
  accountId,
  customFetch,
}: {
  credentials: ResolvedShopifyCredentials;
  accountId: string;
  customFetch?: typeof fetch;
}): Promise<ShopifyStoreCreditAccountResult | null> {
  assertFinancialRewardScope({ credentials, rewardType: "store_credit" });
  const data = await shopifyAdminGraphqlRequest<{
    storeCreditAccount: {
      id: string;
      balance: { amount: string; currencyCode: string };
    } | null;
  }>({
    shopDomain: credentials.shopDomain,
    accessToken: credentials.accessToken,
    query: STORE_CREDIT_ACCOUNT_QUERY,
    variables: { id: formatShopifyGid("StoreCreditAccount", accountId) },
    customFetch,
    maxRetries: 1,
  });
  if (!data.storeCreditAccount) return null;
  return {
    accountId: data.storeCreditAccount.id,
    balance: data.storeCreditAccount.balance.amount,
    currencyCode: data.storeCreditAccount.balance.currencyCode,
  };
}

/**
 * Operator/reconciliation primitive for removing an exact Store Credit amount.
 * Shopify provides no caller idempotency key, so transport ambiguity is never
 * retried automatically after dispatch.
 */
export async function debitShopifyStoreCredit({
  credentials,
  accountId,
  amountMinor,
  currencyCode,
  customFetch,
}: {
  credentials: ResolvedShopifyCredentials;
  accountId: string;
  amountMinor: bigint;
  currencyCode: string;
  customFetch?: typeof fetch;
}): Promise<ShopifyStoreCreditDebitResult> {
  assertFinancialRewardScope({ credentials, rewardType: "store_credit" });
  if (amountMinor <= BigInt(0)) {
    throw new ShopifyFinancialRewardError(
      "INVALID_REQUEST",
      "Store Credit debit amount must be positive.",
    );
  }
  const expectedAmount = minorUnitsToDecimal(amountMinor, currencyCode);
  try {
    const data = await shopifyAdminGraphqlRequest<{
      storeCreditAccountDebit: {
        storeCreditAccountTransaction: {
          id: string;
          amount: { amount: string; currencyCode: string };
          account: {
            id: string;
            balance: { amount: string; currencyCode: string };
          };
        } | null;
        userErrors: Array<{
          field?: string[] | string;
          message: string;
          code?: string;
        }>;
      };
    }>({
      shopDomain: credentials.shopDomain,
      accessToken: credentials.accessToken,
      query: STORE_CREDIT_DEBIT_MUTATION,
      variables: {
        id: formatShopifyGid("StoreCreditAccount", accountId),
        debitInput: {
          debitAmount: { amount: expectedAmount, currencyCode },
        },
      },
      customFetch,
      maxRetries: 0,
      postDispatchOutcomeUnknown: true,
    });
    const payload = data.storeCreditAccountDebit;
    if (payload.userErrors.length > 0) {
      if (payload.storeCreditAccountTransaction) {
        throw new ShopifyFinancialRewardError(
          "REMOTE_CONFIGURATION_MISMATCH",
          "Shopify returned both a Store Credit debit transaction and user errors; manual reconciliation is required.",
          payload.userErrors,
        );
      }
      throw new ShopifyFinancialRewardError(
        "GRAPHQL_USER_ERROR",
        payload.userErrors.map((error) => error.message).join("; "),
        payload.userErrors,
      );
    }
    const transaction = payload.storeCreditAccountTransaction;
    if (
      !transaction ||
      transaction.account.id !==
        formatShopifyGid("StoreCreditAccount", accountId) ||
      transaction.amount.currencyCode !== currencyCode ||
      transaction.account.balance.currencyCode !== currencyCode ||
      !sameMoney(transaction.amount.amount, `-${expectedAmount}`)
    ) {
      throw new ShopifyFinancialRewardError(
        "REMOTE_CONFIGURATION_MISMATCH",
        "Shopify returned a Store Credit debit that does not match the requested account and amount.",
      );
    }
    return {
      transactionId: transaction.id,
      accountId: transaction.account.id,
      amount: transaction.amount.amount,
      currencyCode: transaction.amount.currencyCode,
      balanceAfter: transaction.account.balance.amount,
    };
  } catch (error) {
    return mapTransportError(error);
  }
}
