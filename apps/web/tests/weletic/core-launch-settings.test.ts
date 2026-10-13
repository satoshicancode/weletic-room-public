import { CoreLaunchDeferredError } from "@/lib/weletic/core-launch-policy";
import { writeValidatedLoyaltySettingsInTransaction as write } from "@/lib/weletic/loyalty/settings-writer";
import type { Prisma, WeleticLoyaltyProgram } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/weletic/loyalty/earn-policy-revision", () => ({
  publishLoyaltyEarnPolicyRevision: vi.fn(),
}));
afterEach(() => vi.unstubAllEnvs());
describe("core settings lifecycle", () => {
  let saved: WeleticLoyaltyProgram | null;
  const upsert = vi.fn(({ create, update }) => {
    saved = saved
      ? {
          ...saved,
          ...Object.fromEntries(
            Object.entries(update).filter(([, v]) => v !== undefined),
          ),
        }
      : create;
    return saved;
  });
  const tx = {
    weleticLoyaltyProgram: { findUnique: vi.fn(() => saved), upsert },
  } as unknown as Prisma.TransactionClient;
  beforeEach(() => {
    saved = null;
    vi.clearAllMocks();
    vi.stubEnv("WELETIC_FEATURE_PROFILE", "core-v1");
  });
  it("creates, pauses and resumes without enabling VIP or expiry", async () => {
    await expect(
      write(tx, "store", { status: "active" }),
    ).resolves.toMatchObject({
      vipAutoDowngradeEnabled: false,
      pointsExpiryDays: 0,
      pointsExpiryMonths: 0,
    });
    await expect(
      write(tx, "store", { killSwitchActive: true }),
    ).resolves.toMatchObject({ killSwitchActive: true });
    await expect(
      write(tx, "store", { killSwitchActive: false }),
    ).resolves.toMatchObject({
      killSwitchActive: false,
      vipAutoDowngradeEnabled: false,
    });
  });
  it("permits containment but refuses to resume deferred expiry", async () => {
    await write(tx, "store", { status: "active" });
    saved = { ...saved!, pointsExpiryDays: 30 };
    await expect(
      write(tx, "store", { killSwitchActive: true }),
    ).resolves.toMatchObject({ killSwitchActive: true });
    await expect(
      write(tx, "store", { killSwitchActive: false }),
    ).rejects.toBeInstanceOf(CoreLaunchDeferredError);
    await expect(
      write(tx, "store", { killSwitchActive: false, parsedExpiryDays: 0 }),
    ).resolves.toMatchObject({ killSwitchActive: false, pointsExpiryDays: 0 });
  });
});
