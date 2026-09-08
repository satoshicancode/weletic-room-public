import { beforeEach, expect, it, vi } from "vitest";
import { manageShopifyCommunicationsInTransaction } from "../../lib/weletic/shopify/communications";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  fence: vi.fn(),
}));
vi.mock("../../lib/weletic/shopify/staff-authorization", async (original) => ({
  ...(await original<object>()),
  authorizeShopifyMerchantInTransaction: mocks.auth,
}));
vi.mock("../../lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.fence,
}));
vi.mock("../../lib/weletic/shopify/settings-capabilities", () => ({
  readSettingsCapabilities: vi.fn().mockResolvedValue({ loyalty: true }),
}));
vi.mock("../../lib/weletic/loyalty/communications-service", () => ({
  readLoyaltyCommunicationsInTransaction: mocks.read,
  saveLoyaltyCommunicationsInTransaction: mocks.save,
}));
const actor = {
  storeId: "store-fixture",
  projectId: "project-fixture",
  installationGeneration: "generation-fixture",
};
const findUnique = vi.fn();
const tx = { weleticShopifyStore: { findUnique } };
const template = {
  subject: "Hello",
  heading: "Loyalty",
  body: "Update",
  actionLabel: "View",
};
const save = {
  operation: "save",
  expectedInstallationGeneration: "generation-fixture",
  expectedRevision: "a".repeat(64),
  policy: {
    journey: "birthday",
    enabled: false,
    templates: { en: template, ja: template, vi: template },
  },
};
const run = (request: unknown) =>
  manageShopifyCommunicationsInTransaction({
    tx: tx as any,
    envelope: { signedFixture: true },
    request,
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(actor);
  mocks.fence.mockResolvedValue(undefined);
  mocks.read.mockResolvedValue({ revision: "a".repeat(64), policies: [] });
  mocks.save.mockResolvedValue({ revision: "b".repeat(64), policies: [] });
  findUnique.mockResolvedValue({ projectId: actor.projectId });
});
it("uses authenticated tenant and read permission without granting delivery", async () => {
  const result = await run({ operation: "read" });
  expect(mocks.auth).toHaveBeenCalledWith(
    expect.objectContaining({ permission: "loyalty.read" }),
  );
  expect(mocks.read).toHaveBeenCalledWith(tx, actor.storeId);
  expect(result.storeId).toBe(actor.storeId);
  expect(mocks.save).not.toHaveBeenCalled();
});
it("requires configure permission and operational generation fence before saving", async () => {
  await run(save);
  expect(mocks.auth).toHaveBeenCalledWith(
    expect.objectContaining({ permission: "loyalty.configure" }),
  );
  expect(mocks.fence).toHaveBeenCalledWith(
    expect.objectContaining({
      storeId: actor.storeId,
      expectedInstallationGeneration: actor.installationGeneration,
    }),
  );
  expect(mocks.save).toHaveBeenCalledWith({
    tx,
    storeId: actor.storeId,
    installationGeneration: actor.installationGeneration,
    request: save,
  });
});
it("rejects a changed project binding before reading or writing", async () => {
  findUnique.mockResolvedValue({ projectId: "other-project" });
  await expect(run(save)).rejects.toThrow();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalled();
});
it("does not persist when operational writes or staff authorization are denied", async () => {
  mocks.fence.mockRejectedValue(new Error("blocked"));
  await expect(run(save)).rejects.toThrow("blocked");
  expect(mocks.save).not.toHaveBeenCalled();
  mocks.auth.mockRejectedValue(new Error("access denied"));
  await expect(run({ operation: "read" })).rejects.toThrow("access denied");
  expect(mocks.read).not.toHaveBeenCalled();
});
