import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createLoyaltyMaintenanceLeaseMetadata,
  createLoyaltyMaintenanceOwnerPermit,
} from "../../lib/weletic/loyalty/maintenance-write-fence";
import {
  createReferralCommunicationOrigin,
  type ReferralCommunicationIdentity,
} from "../../lib/weletic/loyalty/referral-communication-origin";
import {
  assertReferralCommunicationOrigin,
  ReferralCommunicationOriginBlockedError,
} from "../../lib/weletic/loyalty/referral-communication-origin-fence";

const guard = vi.hoisted(() => vi.fn());
vi.mock("../../lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: guard,
}));
const tx = {} as Prisma.TransactionClient;
const identity: ReferralCommunicationIdentity = {
  storeId: "store",
  programId: "program",
  referralId: "referral",
  qualificationOrderId: "order",
  accountId: "account",
  side: "advocate",
};
function fixture() {
  return {
    tx,
    identity,
    metadata: {
      referralCommunicationOrigins: {
        advocate: createReferralCommunicationOrigin({
          ...identity,
          installationGeneration: "original-generation",
          qualificationPath: "account_referral",
          qualifiedAt: "2026-09-13T00:00:00Z",
          kind: "points",
          points: "100",
        }),
      },
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  guard.mockResolvedValue({ installationGeneration: "original-generation" });
});
it("checks only the recorded generation using the caller transaction", async () => {
  const result = await assertReferralCommunicationOrigin(fixture());
  expect(result?.installationGeneration).toBe("original-generation");
  expect(guard).toHaveBeenCalledExactlyOnceWith({
    tx,
    storeId: "store",
    expectedInstallationGeneration: "original-generation",
    action: "loyalty_referral_communication_origin",
    loyaltyMaintenancePermit: undefined,
  });
});
it("forwards the exact owner permit without replacing generation provenance", async () => {
  const ownerToken = "synthetic-referral-origin-maintenance-owner-token";
  const metadata = createLoyaltyMaintenanceLeaseMetadata({
    existingMetadata: null,
    ownerToken,
    runMarker: "referral-origin-test",
    fixtureEmails: ["referral-origin@example.test"],
    acquiredAt: new Date("2026-09-13T00:00:00Z"),
    recoveryAfter: new Date("2026-09-14T00:00:00Z"),
  });
  const permit = createLoyaltyMaintenanceOwnerPermit({
    storeId: identity.storeId,
    metadata: metadata as Prisma.JsonObject,
    ownerToken,
  });
  await assertReferralCommunicationOrigin({
    ...fixture(),
    loyaltyMaintenancePermit: permit,
  });
  expect(guard.mock.calls[0][0].loyaltyMaintenancePermit).toBe(permit);
  expect(guard.mock.calls[0][0].expectedInstallationGeneration).toBe(
    "original-generation",
  );
});
it.each(["stale generation", "suspended", "privacy fence", "maintenance"])(
  "preserves %s rejection as typed deferral without modifying metadata",
  async (reason) => {
    const input = fixture();
    const before = JSON.stringify(input.metadata);
    const cause = new Error(reason);
    guard.mockRejectedValue(cause);
    const error = await assertReferralCommunicationOrigin(input).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(ReferralCommunicationOriginBlockedError);
    expect(error).toHaveProperty("cause", cause);
    expect(JSON.stringify(input.metadata)).toBe(before);
  },
);
it.each([undefined, null, {}, { historical: true }])(
  "never retrofits a missing legacy origin (%j)",
  async (metadata) => {
    await expect(
      assertReferralCommunicationOrigin({ ...fixture(), metadata }),
    ).resolves.toBeNull();
    expect(guard).not.toHaveBeenCalled();
  },
);
it.each([
  "storeId",
  "programId",
  "referralId",
  "qualificationOrderId",
  "accountId",
] as const)("rejects a foreign %s before checking admission", async (field) => {
  await expect(
    assertReferralCommunicationOrigin({
      ...fixture(),
      identity: { ...identity, [field]: "foreign" },
    }),
  ).rejects.toBeInstanceOf(ReferralCommunicationOriginBlockedError);
  expect(guard).not.toHaveBeenCalled();
});
it("does not substitute another side's origin", async () => {
  await expect(
    assertReferralCommunicationOrigin({
      ...fixture(),
      identity: { ...identity, side: "referee" },
    }),
  ).resolves.toBeNull();
  expect(guard).not.toHaveBeenCalled();
});
it("rejects present corrupt evidence instead of treating it as legacy", async () => {
  await expect(
    assertReferralCommunicationOrigin({
      ...fixture(),
      metadata: { referralCommunicationOrigins: { advocate: null } },
    }),
  ).rejects.toBeInstanceOf(ReferralCommunicationOriginBlockedError);
  expect(guard).not.toHaveBeenCalled();
});
