import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readShopifyFlowGrantsInTransaction } from "../../lib/weletic/shopify/merchant-flow-grants-read";
const mocks = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("../../lib/weletic/shopify/staff-authorization", async (original) => ({
  ...(await original<
    typeof import("../../lib/weletic/shopify/staff-authorization")
  >()),
  authorizeShopifyMerchantInTransaction: mocks.authorize,
}));
const scope = {
  storeId: "store-1",
  appId: "app-1",
  installationGeneration: "g1",
};
const now = new Date("2026-09-20T00:00:00Z");
const row = (character = "a") => ({
  id: `wflowgrant_${character.repeat(20)}`,
  revision: 1,
  allowCredit: true,
  allowDebit: false,
  maxAbsolutePointsPerAction: new Prisma.Decimal("9223372036854775808"),
  absolutePointsBudget: new Prisma.Decimal("18446744073709551615"),
  absolutePointsUsed: new Prisma.Decimal("9007199254740993"),
  createdAt: now,
  expiresAt: new Date("2026-10-01"),
  revokedAt: null as Date | null,
});
const fixture = () => ({
  $queryRaw: vi.fn().mockResolvedValue([{ now }]),
  weleticShopifyMerchantAction: { findMany: vi.fn().mockResolvedValue([]) },
  weleticShopifyFlowPointsGrant: {
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([row()]),
  },
});
let db = fixture();
const read = (input: unknown = { expectedInstallationGeneration: "g1" }) =>
  readShopifyFlowGrantsInTransaction({
    tx: db as unknown as Prisma.TransactionClient,
    envelope: { signed: true },
    input,
  });
beforeEach(() => {
  vi.clearAllMocks();
  db = fixture();
  mocks.authorize.mockResolvedValue({ ...scope, owner: true });
});
describe("owner Flow grant listing (mocked SQL/authority)", () => {
  it("looks up one grant within authenticated scope without a pagination window", async () => {
    await read({ expectedInstallationGeneration: "g1", grantId: row().id });
    expect(db.weleticShopifyFlowPointsGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...scope, id: row().id } }),
    );
    expect(db.weleticShopifyFlowPointsGrant.findFirst).not.toHaveBeenCalled();
  });
  it("rejects combined exact recovery and pagination selectors", async () => {
    await expect(
      read({
        expectedInstallationGeneration: "g1",
        grantId: row().id,
        cursor: row().id,
      }),
    ).rejects.toThrow();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
  it("returns only exact quantities and grant lifecycle fields, without actor/audit/tenant identifiers", async () => {
    db.weleticShopifyFlowPointsGrant.findMany.mockResolvedValue([
      {
        ...row(),
        approvedByShopifyUserId: "private-user",
        approvedMerchantActionId: "private-audit",
        storeId: "private-store",
      },
    ]);
    const result = await read();
    expect(result.grants[0]).toMatchObject({
      absolutePointsBudget: "18446744073709551615",
      remainingAbsolutePoints: "18437736874454810622",
      status: "active",
    });
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx: db,
      envelope: { signed: true },
      permission: "loyalty.configure",
      recordAction: false,
    });
    expect(db.weleticShopifyFlowPointsGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: scope, take: 21 }),
    );
  });
  it.each(["owner", "generation"])(
    "rejects invalid %s before grant reads",
    async (failure) => {
      mocks.authorize.mockResolvedValue({
        ...scope,
        owner: failure !== "owner",
      });
      await expect(
        read({
          expectedInstallationGeneration:
            failure === "generation" ? "g2" : "g1",
        }),
      ).rejects.toMatchObject({
        code: failure === "owner" ? "access_denied" : "state_changed",
      });
      expect(db.weleticShopifyFlowPointsGrant.findMany).not.toHaveBeenCalled();
    },
  );
  it("requires a cursor in the exact authenticated scope", async () => {
    await expect(
      read({ expectedInstallationGeneration: "g1", cursor: row().id }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(db.weleticShopifyFlowPointsGrant.findFirst).toHaveBeenCalledWith({
      where: { ...scope, id: row().id },
      select: { createdAt: true, id: true },
    });
    expect(db.weleticShopifyFlowPointsGrant.findMany).not.toHaveBeenCalled();
  });
  it("bounds a page and uses timestamp plus ID for stable same-time pagination", async () => {
    db.weleticShopifyFlowPointsGrant.findFirst.mockResolvedValue({
      createdAt: now,
      id: row("z").id,
    });
    db.weleticShopifyFlowPointsGrant.findMany.mockResolvedValue([
      row("b"),
      row("a"),
    ]);
    const result = await read({
      expectedInstallationGeneration: "g1",
      cursor: row("z").id,
      limit: 1,
    });
    expect(result.grants).toHaveLength(1);
    expect(result.nextCursor).toBe(row("b").id);
    expect(db.weleticShopifyFlowPointsGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        where: {
          ...scope,
          OR: [
            { createdAt: { lt: now } },
            { createdAt: now, id: { lt: row("z").id } },
          ],
        },
      }),
    );
  });
  it("recovers only the grant attached to the exact prior owner action", async () => {
    db.weleticShopifyMerchantAction.findMany.mockResolvedValue([
      { id: "approval-id" },
    ]);
    await read({
      expectedInstallationGeneration: "g1",
      approvalRequestId: "b".repeat(64),
    });
    expect(db.weleticShopifyMerchantAction.findMany).toHaveBeenCalledWith({
      where: {
        ...scope,
        requestId: "b".repeat(64),
        owner: true,
        permission: "loyalty.configure",
      },
      select: { id: true },
      take: 2,
    });
    expect(db.weleticShopifyFlowPointsGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ...scope, approvedMerchantActionId: "approval-id" },
      }),
    );
  });
  it("does not fall back to an unfiltered list when recovery has no matching action", async () => {
    expect(
      (
        await read({
          expectedInstallationGeneration: "g1",
          approvalRequestId: "b".repeat(64),
        })
      ).grants,
    ).toEqual([]);
    expect(db.weleticShopifyFlowPointsGrant.findMany).not.toHaveBeenCalled();
  });
  it.each(["revoked", "expired", "exhausted"])(
    "projects %s status using database time",
    async (status) => {
      const grant = row();
      if (status === "revoked") grant.revokedAt = now;
      if (status === "expired") grant.expiresAt = now;
      if (status === "exhausted")
        grant.absolutePointsUsed = grant.absolutePointsBudget;
      db.weleticShopifyFlowPointsGrant.findMany.mockResolvedValue([grant]);
      expect((await read()).grants[0].status).toBe(status);
    },
  );
  it.each([
    { limit: 51 },
    { cursor: "bad" },
    { approvalRequestId: "bad" },
    { cursor: row().id, approvalRequestId: "b".repeat(64) },
    { storeId: "foreign" },
  ])("rejects invalid input %j before authorization", async (change) => {
    await expect(
      read({ expectedInstallationGeneration: "g1", ...change }),
    ).rejects.toThrow();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});
