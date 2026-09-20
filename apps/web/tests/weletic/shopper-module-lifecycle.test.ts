import { upsertWeleticShopper } from "@/lib/weletic/loyalty/shopper";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    weleticShopper: { findUnique: vi.fn(), upsert: vi.fn() },
    weleticLoyaltyProgram: { findUnique: vi.fn(), create: vi.fn() },
    weleticLoyaltyAccount: { create: vi.fn() },
    weleticLoyaltyEarningRule: { findFirst: vi.fn() },
    weleticLoyaltyOutboxJob: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return {
    tx,
    transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    fence: vi.fn(),
    tombstone: vi.fn(),
    legacyTombstone: vi.fn(),
    signup: vi.fn(),
    projection: vi.fn(),
    lockSource: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.fence,
}));
vi.mock("@/lib/weletic/shopify/privacy-identity", () => ({
  hasShopifyCustomerPrivacyTombstone: mocks.tombstone,
}));
vi.mock("@/lib/weletic/loyalty/shopper-privacy", () => ({
  hasShopifyCustomerRedactionTombstone: mocks.legacyTombstone,
  anonymizeWeleticShopper: vi.fn(),
  getShopperDataExport: vi.fn(),
}));
vi.mock("@/lib/weletic/loyalty/non-purchase-earn", () => ({
  awardSignupWelcomeBonus: mocks.signup,
}));
vi.mock("@/lib/weletic/reviews/privacy-owner-write", () => ({
  replaceReviewOwnerPrivacyProjection: mocks.projection,
  lockReviewOwnerPrivacySource: mocks.lockSource,
}));

const shopper = { id: "shopper_lifecycle", storeId: "store_lifecycle" };
const activeProgram = {
  id: "program_lifecycle",
  storeId: shopper.storeId,
  status: "active",
  killSwitchActive: false,
};
const account = {
  id: "account_lifecycle",
  shopperId: shopper.id,
  storeId: shopper.storeId,
  programId: activeProgram.id,
  status: "active",
  cachedPointsBalance: BigInt("123456789012345678"),
  metadata: null,
};
const input = {
  storeId: shopper.storeId,
  customer: { id: "42", email: "shopper@example.test" },
  expectedInstallationGeneration: "generation_lifecycle",
};

describe("shared shopper ingestion and explicit loyalty activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fence.mockResolvedValue({
      installationGeneration: "generation_lifecycle",
    });
    mocks.projection.mockReset().mockResolvedValue({ identityCount: 2 });
    mocks.lockSource.mockReset().mockResolvedValue({});
    mocks.tombstone.mockResolvedValue(false);
    mocks.legacyTombstone.mockReturnValue(false);
    mocks.tx.weleticShopper.findUnique.mockResolvedValue(null);
    mocks.tx.weleticShopper.upsert.mockResolvedValue(shopper);
    mocks.tx.weleticLoyaltyProgram.findUnique.mockResolvedValue(activeProgram);
    mocks.tx.weleticLoyaltyAccount.create.mockResolvedValue(account);
    mocks.tx.weleticLoyaltyEarningRule.findFirst.mockResolvedValue({
      id: "rule_signup",
      name: "Welcome",
      fixedPoints: BigInt(100),
    });
  });

  it.each([
    null,
    { ...activeProgram, status: "draft" },
    { ...activeProgram, status: "test" },
    { ...activeProgram, status: "disabled" },
    { ...activeProgram, killSwitchActive: true },
  ])("does not enroll shoppers while loyalty is off: %j", async (program) => {
    mocks.tx.weleticLoyaltyProgram.findUnique.mockResolvedValue(program);
    expect(await upsertWeleticShopper(input)).toEqual({
      shopper,
      loyaltyProgram: program,
      loyaltyAccount: null,
      loyaltyAccountCreated: false,
      privacyTombstoned: false,
    });
    expect(mocks.tx.weleticShopper.upsert).toHaveBeenCalledOnce();
    expect(mocks.projection).toHaveBeenCalledWith({
      tx: mocks.tx,
      storeId: shopper.storeId,
      shopperId: shopper.id,
      installationGeneration: "generation_lifecycle",
      loyaltyMaintenancePermit: undefined,
    });
    expect(mocks.tx.weleticLoyaltyProgram.create).not.toHaveBeenCalled();
    expect(mocks.tx.weleticLoyaltyAccount.create).not.toHaveBeenCalled();
    expect(mocks.tx.weleticLoyaltyEarningRule.findFirst).not.toHaveBeenCalled();
    expect(mocks.signup).not.toHaveBeenCalled();
  });

  it.each(["active", "closed", "suspended"])(
    "preserves an existing %s account and its balance while loyalty is disabled",
    async (status) => {
      const existingAccount = { ...account, status };
      const program = { ...activeProgram, status: "disabled" };
      mocks.tx.weleticShopper.findUnique.mockResolvedValue({
        ...shopper,
        loyaltyAccount: { ...existingAccount, program },
      });
      mocks.tx.weleticLoyaltyProgram.findUnique.mockResolvedValue(program);
      const result = await upsertWeleticShopper(input);
      expect(result?.loyaltyAccount).toEqual(existingAccount);
      expect(result?.loyaltyAccountCreated).toBe(false);
      expect(mocks.tx.weleticLoyaltyAccount.create).not.toHaveBeenCalled();
      expect(mocks.signup).not.toHaveBeenCalled();
    },
  );

  it("enrolls an existing reviews-only shopper after explicit activation, not again on replay", async () => {
    mocks.tx.weleticShopper.findUnique.mockResolvedValue({
      ...shopper,
      loyaltyAccount: null,
    });
    const result = await upsertWeleticShopper(input);
    expect(result?.loyaltyAccountCreated).toBe(true);
    expect(mocks.tx.weleticLoyaltyAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        shopperId: shopper.id,
        storeId: shopper.storeId,
        programId: activeProgram.id,
        status: "active",
      }),
    });
    expect(mocks.signup).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: mocks.tx,
        accountId: account.id,
        bonusPoints: BigInt(100),
      }),
    );
    mocks.tx.weleticShopper.findUnique.mockResolvedValue({
      ...shopper,
      loyaltyAccount: { ...account, program: activeProgram },
    });
    expect((await upsertWeleticShopper(input))?.loyaltyAccountCreated).toBe(
      false,
    );
    expect(mocks.tx.weleticLoyaltyAccount.create).toHaveBeenCalledOnce();
    expect(mocks.signup).toHaveBeenCalledOnce();
  });

  it("does not reopen a closed account when loyalty is reactivated", async () => {
    mocks.tx.weleticShopper.findUnique.mockResolvedValue({
      ...shopper,
      loyaltyAccount: { ...account, status: "closed", program: activeProgram },
    });
    expect((await upsertWeleticShopper(input))?.loyaltyAccount?.status).toBe(
      "closed",
    );
    expect(mocks.tx.weleticLoyaltyAccount.create).not.toHaveBeenCalled();
    expect(mocks.signup).not.toHaveBeenCalled();
  });

  it("does not manufacture active coverage for legacy stores without a generation", async () => {
    mocks.fence.mockResolvedValue({ installationGeneration: null });
    mocks.tx.weleticLoyaltyProgram.findUnique.mockResolvedValue(null);
    await upsertWeleticShopper({
      ...input,
      expectedInstallationGeneration: undefined,
    });
    expect(mocks.projection).not.toHaveBeenCalled();
    expect(mocks.tx.weleticLoyaltyAccount.create).not.toHaveBeenCalled();
  });

  it("checks the saved email before allowing an identity change", async () => {
    mocks.tx.weleticShopper.findUnique.mockResolvedValue({
      ...shopper,
      email: "old@example.test",
      loyaltyAccount: null,
    });
    mocks.tombstone.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect((await upsertWeleticShopper(input))?.privacyTombstoned).toBe(true);
    expect(mocks.tombstone).toHaveBeenLastCalledWith({
      tx: mocks.tx,
      storeId: shopper.storeId,
      shopifyCustomerId: "42",
      email: "old@example.test",
    });
    expect(mocks.tx.weleticShopper.upsert).not.toHaveBeenCalled();
    expect(mocks.projection).not.toHaveBeenCalled();
  });

  it("propagates projection failure before enrollment or signup writes", async () => {
    mocks.projection.mockRejectedValueOnce(new Error("projection unavailable"));
    await expect(upsertWeleticShopper(input)).rejects.toThrow(
      "projection unavailable",
    );
    expect(mocks.tx.weleticLoyaltyAccount.create).not.toHaveBeenCalled();
    expect(mocks.signup).not.toHaveBeenCalled();
  });

  it("locks retained saved-identity suppression before any source rewrite", async () => {
    mocks.tx.weleticShopper.findUnique.mockResolvedValue({
      ...shopper,
      email: "old@example.test",
      loyaltyAccount: null,
    });
    mocks.lockSource.mockRejectedValueOnce(
      new Error("Review privacy source suppressed"),
    );
    await expect(upsertWeleticShopper(input)).rejects.toThrow(
      "Review privacy source suppressed",
    );
    expect(mocks.tx.weleticShopper.upsert).not.toHaveBeenCalled();
    expect(mocks.projection).not.toHaveBeenCalled();
  });

  it("passes installation fencing into the same transaction before shopper writes", async () => {
    mocks.fence.mockRejectedValueOnce(new Error("stale installation"));
    await expect(upsertWeleticShopper(input)).rejects.toThrow(
      "stale installation",
    );
    expect(mocks.fence).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: mocks.tx,
        storeId: input.storeId,
        expectedInstallationGeneration: input.expectedInstallationGeneration,
      }),
    );
    expect(mocks.tx.weleticShopper.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.weleticLoyaltyAccount.create).not.toHaveBeenCalled();
  });
});
