import { readHistoricalImportCommitRowInTransaction } from "@/lib/weletic/loyalty/historical-import-commit-row";
import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lease: vi.fn(), identities: vi.fn() }));
vi.mock("@/lib/weletic/loyalty/historical-import-execution-lease", () => ({
  assertHistoricalImportExecutionLeaseInTransaction: mocks.lease,
}));
vi.mock("@/lib/weletic/shopify/privacy-identity", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/weletic/shopify/privacy-identity")
  >()),
  deriveAllShopifyCustomerPrivacyIdentities: mocks.identities,
}));
vi.mock("@/lib/weletic/loyalty/shopper-privacy", () => ({
  hasShopifyCustomerRedactionTombstone: (metadata: unknown) =>
    Boolean(metadata && typeof metadata === "object" && "redacted" in metadata),
}));
const scope = {
  sourceId: "source",
  storeId: "store",
  programId: "program",
  installationGeneration: "generation",
  phase: "committing",
  leaseId: "lease",
  revision: 1,
};
const snapshotBase = {
  id: "snapshot",
  sourceId: "source",
  storeId: "store",
  programId: "program",
  rowNumber: 1,
  shopifyCustomerId: "gid://shopify/Customer/123",
  openingBalance: BigInt("9007199254740993"),
  birthdayMonth: null,
  birthdayDay: null,
  tierId: null,
  createdAt: new Date("2026-09-01"),
  redactedAt: null,
};
const shopperBase = {
  id: "shopper",
  storeId: "store",
  shopifyCustomerId: "123",
  email: "private@example.test",
};
const accountBase = {
  id: "account",
  storeId: "store",
  programId: "program",
  shopperId: "shopper",
  status: "active",
  metadata: null,
  cachedPointsBalance: BigInt(2),
  ledgerVersion: 4,
};
let snapshots: unknown[];
let shoppers: unknown[];
let accounts: unknown[];
let tombstones: unknown[];
let tiers: unknown[];
const raw = vi.fn();
const tx = { $queryRaw: raw } as unknown as Prisma.TransactionClient;
const run = () =>
  readHistoricalImportCommitRowInTransaction({
    tx,
    lease: scope,
    snapshotId: "snapshot",
  });
beforeEach(() => {
  vi.resetAllMocks();
  snapshots = [{ ...snapshotBase }];
  shoppers = [{ ...shopperBase }];
  accounts = [{ ...accountBase }];
  tombstones = [];
  tiers = [];
  mocks.lease.mockResolvedValue({
    lease: scope,
    now: new Date("2026-09-09T00:00:00.000Z"),
  });
  mocks.identities.mockReturnValue([
    {
      identityKind: "shopify_customer_id",
      identityKeyId: "key",
      customerDigest: "digest",
    },
  ]);
  raw.mockImplementation(async (query: Prisma.Sql) => {
    if (query.sql.includes("FROM WeleticLoyaltyImportRowSnapshot"))
      return snapshots;
    if (query.sql.includes("FROM WeleticShopper")) return shoppers;
    if (query.sql.includes("FROM WeleticLoyaltyAccount")) return accounts;
    if (query.sql.includes("FROM WeleticShopifyCustomerPrivacyTombstone"))
      return tombstones;
    if (query.sql.includes("FROM WeleticLoyaltyTier")) return tiers;
    throw new Error("Unexpected query");
  });
});
it("reads stored values under the current lease without any write delegate", async () => {
  const result = await run();
  expect(result.balanceAfter).toBe(BigInt("9007199254740995"));
  expect(result.account?.id).toBe("account");
  expect(mocks.lease.mock.invocationCallOrder[0]).toBeLessThan(
    raw.mock.invocationCallOrder[0],
  );
  expect(
    raw.mock.calls.every(([query]) => query.sql.includes("FOR UPDATE")),
  ).toBe(true);
  expect(raw.mock.calls[0][0].values).toEqual([
    "snapshot",
    "source",
    "store",
    "program",
  ]);
  const privacy = raw.mock.calls[3][0];
  expect(privacy.sql).toContain("expiresAt >");
  expect(privacy.values).toEqual([
    "store",
    "shopper",
    "account",
    new Date("2026-09-09T00:00:00.000Z"),
    "shopify_customer_id",
    "key",
    "digest",
  ]);
});
it("allows an eligible unenrolled shopper without creating an account", async () => {
  accounts = [];
  const result = await run();
  expect(result.account).toBeNull();
  expect(result.balanceAfter).toBe(snapshotBase.openingBalance);
});
it.each(["expired", "rollback"])(
  "rejects %s leases before snapshot access",
  async (kind) => {
    if (kind === "expired") mocks.lease.mockRejectedValue(new Error("expired"));
    else
      mocks.lease.mockResolvedValue({
        lease: { ...scope, phase: "rolling_back" },
        now: new Date(),
      });
    await expect(run()).rejects.toThrow();
    expect(raw).not.toHaveBeenCalled();
  },
);
it.each([
  { storeId: "other" },
  { programId: "other" },
  { sourceId: "other" },
  { redactedAt: new Date() },
  { openingBalance: BigInt(-1) },
  { birthdayMonth: 2 },
  { rowNumber: 0 },
])(
  "rejects invalid stored snapshot case %# before resolving identity",
  async (change) => {
    snapshots = [{ ...snapshotBase, ...change }];
    await expect(run()).rejects.toThrow("state changed");
    expect(raw).toHaveBeenCalledTimes(1);
  },
);
it.each([
  { values: [] },
  {
    values: [
      shopperBase,
      {
        ...shopperBase,
        id: "duplicate",
        shopifyCustomerId: snapshotBase.shopifyCustomerId,
      },
    ],
  },
  { values: [{ ...shopperBase, storeId: "other" }] },
])("rejects missing, ambiguous or foreign shoppers %j", async ({ values }) => {
  shoppers = values;
  await expect(run()).rejects.toThrow("state changed");
  expect(raw).toHaveBeenCalledTimes(2);
  expect(mocks.identities).not.toHaveBeenCalled();
});
it.each([
  { storeId: "other" },
  { programId: "other" },
  { shopperId: "other" },
  { status: "closed" },
  { metadata: { redacted: true } },
])("rejects current account ineligible state %j", async (change) => {
  accounts = [{ ...accountBase, ...change }];
  await expect(run()).rejects.toThrow();
  expect(mocks.identities).not.toHaveBeenCalled();
});
it("rejects a current privacy tombstone even if preview was previously eligible", async () => {
  tombstones = [{ id: "tombstone" }];
  await expect(run()).rejects.toThrow();
});
it("rejects balance overflow and exhausted ledger versions", async () => {
  accounts = [
    { ...accountBase, cachedPointsBalance: BigInt("9223372036854775807") },
  ];
  await expect(run()).rejects.toThrow();
  accounts = [{ ...accountBase, ledgerVersion: 2147483647 }];
  await expect(run()).rejects.toThrow();
});
it("rechecks birthdays and tiers without applying them or enqueueing rewards", async () => {
  snapshots = [
    { ...snapshotBase, birthdayMonth: 2, birthdayDay: 29, tierId: "tier" },
  ];
  tiers = [{ id: "tier", programId: "program" }];
  const result = await run();
  expect(result.birthday.schedule?.birthDate).toBe("2000-02-29");
  expect(accounts).toEqual([accountBase]);
  accounts = [
    {
      ...accountBase,
      metadata: {
        birthday: {
          birthDate: "2000-01-01",
          registeredAt: "2025-01-01T00:00:00.000Z",
        },
      },
    },
  ];
  await expect(run()).rejects.toThrow();
  accounts = [accountBase];
  tiers = [];
  await expect(run()).rejects.toThrow();
});
