import { ensureOpenReviewAuthorInTransaction } from "@/lib/weletic/reviews/open-submission-author";
import { ReviewOwnerPrivacySuppressedError } from "@/lib/weletic/reviews/privacy-owner-write";
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  projection: vi.fn(),
  query: vi.fn(),
  create: vi.fn(),
  settings: vi.fn(),
  existing: vi.fn(),
  suppressed: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.guard,
}));
vi.mock("@/lib/weletic/reviews/privacy-owner-write", () => ({
  replaceReviewOwnerPrivacyProjection: mocks.projection,
  ReviewOwnerPrivacySuppressedError: class extends Error {},
}));
vi.mock("@/lib/weletic/shopify/privacy-identity", async (original) => ({
  ...(await original<object>()),
  deriveAllShopifyCustomerPrivacyIdentities: () => [
    {
      identityKind: "customer_id",
      identityKeyId: "test-key",
      customerDigest: "a".repeat(64),
    },
  ],
}));
const tx = {
  $queryRaw: mocks.query,
  weleticShopper: { create: mocks.create },
  weleticReviewSettings: { findUnique: mocks.settings },
} as unknown as Prisma.TransactionClient;
const run = (
  customer = {
    shopifyCustomerId: "gid://shopify/Customer/123",
    email: "shopper@example.invalid" as string | null,
  },
) =>
  ensureOpenReviewAuthorInTransaction({
    tx,
    storeId: "store",
    installationGeneration: "g1",
    customer,
  });

describe("identity-only open review author", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.settings.mockResolvedValue([{ enabled: true }]);
    mocks.existing.mockResolvedValue([{ id: "existing" }]);
    mocks.suppressed.mockResolvedValue([]);
    mocks.query.mockImplementation(
      (query: Prisma.Sql | TemplateStringsArray) => {
        const sql =
          ("strings" in query ? query.strings : query)?.join("?") ?? "";
        if (sql.includes("FROM WeleticReviewSettings")) return mocks.settings();
        if (sql.includes("FROM WeleticShopifyCustomerPrivacyTombstone"))
          return mocks.suppressed();
        if (sql.includes("FROM WeleticShopper")) return mocks.existing();
        throw new Error("Unexpected identity query");
      },
    );
    mocks.create.mockResolvedValue({ id: "created" });
  });
  it("reuses an author without any profile, consent or account mutation", async () => {
    expect(await run()).toEqual({ shopperId: "existing" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.guard).toHaveBeenCalledWith({
      tx,
      storeId: "store",
      action: "open_review_author",
      expectedInstallationGeneration: "g1",
    });
    expect(mocks.projection).toHaveBeenCalledWith({
      tx,
      storeId: "store",
      shopperId: "existing",
      installationGeneration: "g1",
    });
    const tombstoneSql = mocks.query.mock.calls[1][0];
    expect(tombstoneSql.strings.join("?")).not.toContain("expiresAt");
    expect(tombstoneSql.strings.join("?")).toContain("FOR UPDATE");
  });
  it("creates only minimal identity when no existing author matches", async () => {
    mocks.existing.mockResolvedValue([]);
    expect(await run()).toEqual({ shopperId: "created" });
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        id: expect.stringMatching(/^wshop_/),
        storeId: "store",
        shopifyCustomerId: "123",
        email: "shopper@example.invalid",
      },
      select: { id: true },
    });
  });
  it("accepts explicit known-absent email without creating consent", async () => {
    mocks.existing.mockResolvedValue([]);
    await run({ shopifyCustomerId: "123", email: null });
    expect(mocks.create.mock.calls[0][0].data.email).toBeNull();
    expect(mocks.create.mock.calls[0][0].data).not.toHaveProperty(
      "acceptsMarketing",
    );
  });
  it("rejects retained suppression before identity creation", async () => {
    mocks.suppressed.mockResolvedValue([{ id: "tombstone" }]);
    await expect(run()).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.projection).not.toHaveBeenCalled();
  });
  it("does not select arbitrarily between numeric/GID duplicates", async () => {
    mocks.existing.mockResolvedValue([{ id: "one" }, { id: "two" }]);
    await expect(run()).rejects.toMatchObject({ code: "unavailable" });
    expect(mocks.projection).not.toHaveBeenCalled();
  });
  it("maps terminal owner suppression but preserves unknown failures", async () => {
    mocks.projection.mockRejectedValue(new ReviewOwnerPrivacySuppressedError());
    await expect(run()).rejects.toMatchObject({ code: "not_found" });
    mocks.projection.mockRejectedValue(new Error("corrupt private proof"));
    await expect(run()).rejects.toThrow("corrupt private proof");
  });
  it("refuses disabled reviews before touching customer data", async () => {
    mocks.settings.mockResolvedValue([{ enabled: false }]);
    await expect(run()).rejects.toMatchObject({ code: "disabled" });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.suppressed).not.toHaveBeenCalled();
  });
  it("preserves stale-generation/admission failures without creating an author", async () => {
    mocks.guard.mockRejectedValue(new Error("stale generation"));
    await expect(run()).rejects.toThrow("stale generation");
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([
    "redacted:subject",
    "0",
    "-1",
    "gid://shopify/Product/123",
    "123/456",
  ])(
    "rejects invalid authenticated customer identity %s",
    async (shopifyCustomerId) => {
      await expect(run({ shopifyCustomerId, email: null })).rejects.toThrow();
      expect(mocks.guard).not.toHaveBeenCalled();
    },
  );
});
