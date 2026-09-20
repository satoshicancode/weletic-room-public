import {
  replaceReviewOwnerPrivacyProjection,
  ReviewOwnerPrivacySuppressedError,
} from "@/lib/weletic/reviews/privacy-owner-write";
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
const guard = vi.hoisted(() => vi.fn());
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: guard,
}));

function fixture() {
  const state = {
    shopper: {
      id: "shopper-a",
      storeId: "store-a",
      shopifyCustomerId: "123",
      email: "persisted@example.test",
    },
    accounts: [] as Array<{ metadata: Prisma.JsonValue }>,
    coverage: [] as Array<{ state: string; identityCount?: number }>,
    tombstones: [] as Array<{ id: string }>,
    identities: [] as Array<{
      identityKind: string;
      identityKeyId: string;
      customerDigest: string;
    }>,
  };
  const db = {
    $queryRaw: vi
      .fn()
      .mockImplementation(async (query: TemplateStringsArray | Prisma.Sql) => {
        const sql =
          "strings" in query ? query.strings.join("?") : query.join("?");
        expect(sql).toContain("FOR UPDATE");
        if (sql.includes("FROM WeleticShopper\n")) return [state.shopper];
        if (sql.includes("FROM WeleticLoyaltyAccount")) return state.accounts;
        if (sql.includes("FROM WeleticReviewOwnerPrivacyCoverage"))
          return state.coverage;
        if (sql.includes("FROM WeleticShopifyCustomerPrivacyTombstone"))
          return state.tombstones;
        if (sql.includes("FROM WeleticReviewOwnerPrivacyIdentity"))
          return state.identities;
        throw new Error("Unexpected query");
      }),
    weleticReviewOwnerPrivacyCoverage: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    weleticReviewOwnerPrivacyIdentity: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
  };
  const input = {
    tx: db as unknown as Prisma.TransactionClient,
    storeId: "store-a",
    shopperId: "shopper-a",
    installationGeneration: "g1",
  };
  return {
    db,
    state,
    run: () => replaceReviewOwnerPrivacyProjection(input),
    input,
  };
}

beforeEach(() => guard.mockReset().mockResolvedValue({}));

describe("transaction-scoped review privacy projection replacement", () => {
  it("does not rebuild a whole missing key while another anchor survives", async () => {
    const { state, run, db } = fixture();
    state.coverage = [{ state: "active", identityCount: 4 }];
    state.identities = [
      {
        identityKind: "customer_id",
        identityKeyId: "test-v1",
        customerDigest: "A".repeat(64),
      },
      {
        identityKind: "customer_email",
        identityKeyId: "test-v1",
        customerDigest: "B".repeat(64),
      },
    ];
    await expect(run()).rejects.toThrow("retained identity count mismatch");
    expect(
      db.weleticReviewOwnerPrivacyIdentity.deleteMany,
    ).not.toHaveBeenCalled();
  });
  it.each(["empty", "email_only"])(
    "does not rebuild corrupt active coverage with %s proofs",
    async (kind) => {
      const { state, run, db } = fixture();
      state.coverage = [{ state: "active" }];
      if (kind === "email_only")
        state.identities = [
          {
            identityKind: "customer_email",
            identityKeyId: "test-v1",
            customerDigest: "A".repeat(64),
          },
        ];
      await expect(run()).rejects.toThrow("anchors unavailable");
      expect(
        db.weleticReviewOwnerPrivacyCoverage.upsert,
      ).not.toHaveBeenCalled();
      expect(
        db.weleticReviewOwnerPrivacyIdentity.deleteMany,
      ).not.toHaveBeenCalled();
    },
  );
  it.each(["customer_id", "customer_email"])(
    "does not implicitly retire a missing retained %s key",
    async (identityKind) => {
      const { state, run, db } = fixture();
      state.identities = [
        {
          identityKind,
          identityKeyId: "missing-retained-key",
          customerDigest: "A".repeat(64),
        },
      ];
      await expect(run()).rejects.toThrow(/retained identity/);
      expect(
        db.weleticReviewOwnerPrivacyCoverage.upsert,
      ).not.toHaveBeenCalled();
      expect(
        db.weleticReviewOwnerPrivacyIdentity.deleteMany,
      ).not.toHaveBeenCalled();
    },
  );
  it("rejects mismatched retained customer proofs before replacing coverage", async () => {
    const { state, run, db } = fixture();
    state.identities = [
      {
        identityKind: "customer_id",
        identityKeyId: "test-v1",
        customerDigest: "A".repeat(64),
      },
    ];
    await expect(run()).rejects.toThrow("retained identity proof mismatch");
    expect(db.weleticReviewOwnerPrivacyCoverage.upsert).not.toHaveBeenCalled();
    expect(
      db.weleticReviewOwnerPrivacyIdentity.deleteMany,
    ).not.toHaveBeenCalled();
  });
  it.each(["redacted:broken", `redacted:v1:unavailable-key:${"A".repeat(64)}`])(
    "does not classify corrupt or unverifiable pseudonyms as authoritative suppression: %s",
    async (value) => {
      const { state, run, db } = fixture();
      state.shopper.shopifyCustomerId = value;
      const error = await run().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ReviewOwnerPrivacySuppressedError);
      expect(
        db.weleticReviewOwnerPrivacyCoverage.upsert,
      ).not.toHaveBeenCalled();
    },
  );
  it("locks exact owners and persists complete coverage/identity rows through one transaction", async () => {
    const { db, run, input } = fixture();
    expect(await run()).toEqual({ identityCount: 2 });
    expect(guard).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: input.tx,
        storeId: "store-a",
        expectedInstallationGeneration: "g1",
      }),
    );
    expect(db.$queryRaw.mock.calls[0].slice(1)).toEqual([
      "store-a",
      "shopper-a",
    ]);
    expect(
      db.weleticReviewOwnerPrivacyIdentity.deleteMany,
    ).toHaveBeenCalledWith({
      where: { storeId: "store-a", shopperId: "shopper-a" },
    });
    const inserted =
      db.weleticReviewOwnerPrivacyIdentity.createMany.mock.calls[0][0].data;
    expect(inserted).toHaveLength(2);
    expect(
      inserted.every(
        (row: { storeId: string; shopperId: string }) =>
          row.storeId === "store-a" && row.shopperId === "shopper-a",
      ),
    ).toBe(true);
    expect(
      inserted.map((row: { identityKind: string }) => row.identityKind).sort(),
    ).toEqual(["customer_email", "customer_id"]);
    expect(db.weleticReviewOwnerPrivacyCoverage.upsert).toHaveBeenCalledWith({
      where: {
        storeId_shopperId: { storeId: "store-a", shopperId: "shopper-a" },
      },
      create: expect.objectContaining({
        state: "active",
        identityCount: 2,
        installationGeneration: "g1",
      }),
      update: expect.objectContaining({
        state: "active",
        identityCount: 2,
        installationGeneration: "g1",
      }),
    });
    expect(db.$queryRaw).toHaveBeenCalledTimes(5);
    const tombstoneQuery = db.$queryRaw.mock.calls[4][0] as Prisma.Sql;
    expect(tombstoneQuery.values.slice(0, 2)).toEqual(["store-a", "shopper-a"]);
    expect(tombstoneQuery.values).toContain("customer_email");
    expect(tombstoneQuery.values).toContain("customer_id");
    expect(tombstoneQuery.sql).not.toContain("persisted@example.test");
  });

  it("checks retained email proofs before replacing stale source coverage", async () => {
    const { db, state, run } = fixture();
    state.identities = [
      {
        identityKind: "customer_email",
        identityKeyId: "retained",
        customerDigest: "C".repeat(64),
      },
    ];
    state.tombstones = [{ id: "expired-retained-tombstone" }];
    await expect(run()).rejects.toBeInstanceOf(
      ReviewOwnerPrivacySuppressedError,
    );
    const query = db.$queryRaw.mock.calls[4][0] as Prisma.Sql;
    expect(query.values).toContain("C".repeat(64));
    expect(query.sql).not.toContain("expiresAt");
    expect(
      db.weleticReviewOwnerPrivacyIdentity.deleteMany,
    ).not.toHaveBeenCalled();
  });

  it.each([
    "guard",
    "missing",
    "foreign",
    "redacted",
    "tombstone",
    "pseudonym",
  ])("does not mutate coverage on %s denial", async (kind) => {
    const { db, state, run } = fixture();
    if (kind === "guard")
      guard.mockRejectedValueOnce(new Error("stale generation"));
    if (kind === "missing") db.$queryRaw.mockResolvedValueOnce([]);
    if (kind === "foreign") state.shopper.storeId = "foreign";
    if (kind === "redacted") state.coverage = [{ state: "redacted" }];
    if (kind === "tombstone") state.tombstones = [{ id: "tombstone" }];
    if (kind === "pseudonym")
      state.shopper.shopifyCustomerId = "redacted:v1:key:ABC";
    await expect(run()).rejects.toThrow();
    expect(db.weleticReviewOwnerPrivacyCoverage.upsert).not.toHaveBeenCalled();
    expect(
      db.weleticReviewOwnerPrivacyIdentity.deleteMany,
    ).not.toHaveBeenCalled();
    expect(
      db.weleticReviewOwnerPrivacyIdentity.createMany,
    ).not.toHaveBeenCalled();
  });

  it("propagates row insertion failure so the caller must roll back coverage and source", async () => {
    const { db, run } = fixture();
    db.weleticReviewOwnerPrivacyIdentity.createMany.mockRejectedValueOnce(
      new Error("synthetic insert failure"),
    );
    await expect(run()).rejects.toThrow("synthetic insert failure");
    expect(
      db.weleticReviewOwnerPrivacyIdentity.createMany,
    ).toHaveBeenCalledTimes(1);
  });
});
