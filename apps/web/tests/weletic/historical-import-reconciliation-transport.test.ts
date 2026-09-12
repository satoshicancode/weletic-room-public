import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantImportsAction } from "../../../../packages/shopify-app/app/merchant-imports-action.server";
import { createMerchantImportReconciliationClient } from "../../../../packages/shopify-app/app/merchant-imports-client";
import { weleticApiJson } from "../../../../packages/shopify-app/app/weletic-api.server";
vi.mock("../../../../packages/shopify-app/app/weletic-api.server", () => ({
  weleticApiJson: vi.fn(),
  WeleticGatewayError: class extends Error {},
}));
const input = {
  operation: "reconcile",
  sourceId: "source",
  expectedInstallationGeneration: "generation",
  expectedRevision: "a".repeat(64),
};
const result = {
  storeId: "store",
  installationGeneration: "generation",
  sourceInstallationGeneration: "old",
  sourceId: "source",
  revision: input.expectedRevision,
  status: "committed",
  rowCount: 1,
  totalOpeningBalance: "9007199254740993",
  createdAt: "2026-09-01T00:00:00.000Z",
  completedAt: "2026-09-01T01:00:00.000Z",
  verification: "ledger_provenance",
  reconciled: true,
  fullyCommitted: true,
  fullyRolledBack: false,
  issues: [],
  importedPoints: "9007199254740993",
  reversedPoints: "0",
  expectedNetPoints: "9007199254740993",
  observedNetPoints: "9007199254740993",
};
const auth = vi
  .fn()
  .mockImplementation(async (_request, callback) =>
    callback({ actor: { storeId: "store" } }),
  );
const request = () =>
  new Request("https://app.example/api/merchant/imports", {
    method: "POST",
    body: JSON.stringify({ request: input }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(weleticApiJson).mockResolvedValue(result);
});
it("preserves exact reconciliation evidence through both transport boundaries", async () => {
  const response = await createMerchantImportsAction(auth)(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(result);
  const fetcher = vi.fn().mockResolvedValue(Response.json(result));
  await expect(
    createMerchantImportReconciliationClient(
      async () => "token",
      "store",
      fetcher,
    )(input),
  ).resolves.toEqual(result);
});
it.each([
  { sourceId: "other" },
  { storeId: "other" },
  { installationGeneration: "old" },
  { revision: "b".repeat(64) },
  { verification: "source_record_only" },
  { issues: ["private email"] },
  { observedNetPoints: "9007199254740992" },
  { expectedNetPoints: "0" },
  { importedPoints: 9007199254740993 },
  { status: "preview" },
  { fullyRolledBack: true },
  { reconciled: false },
  { customerEmail: "private@example.test" },
  {
    fullyCommitted: false,
    importedPoints: "0",
    reversedPoints: "0",
    expectedNetPoints: "0",
    observedNetPoints: "0",
  },
  {
    status: "rolled_back",
    fullyCommitted: false,
    fullyRolledBack: false,
    reversedPoints: result.importedPoints,
    expectedNetPoints: "0",
    observedNetPoints: "0",
  },
  { status: "preview", fullyCommitted: false },
  { status: "cancelled", fullyCommitted: false },
])("rejects substituted or inconsistent reconciliation %j", async (change) => {
  const value = { ...result, ...change };
  vi.mocked(weleticApiJson).mockResolvedValue(value);
  const response = await createMerchantImportsAction(auth)(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "imports_unavailable" });
  const fetcher = vi.fn().mockResolvedValue(Response.json(value));
  await expect(
    createMerchantImportReconciliationClient(
      async () => "token",
      "store",
      fetcher,
    )(input),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("reports valid mismatch evidence without claiming completion", async () => {
  const value = {
    ...result,
    reconciled: false,
    fullyCommitted: false,
    issues: ["net_points_mismatch"],
    observedNetPoints: "-1",
  };
  const fetcher = vi.fn().mockResolvedValue(Response.json(value));
  await expect(
    createMerchantImportReconciliationClient(
      async () => "token",
      "store",
      fetcher,
    )(input),
  ).resolves.toEqual(value);
});
it.each(["preview", "cancelled"])(
  "accepts a clean uncommitted %s source without claiming points were posted",
  async (status) => {
    const value = {
      ...result,
      status,
      fullyCommitted: false,
      importedPoints: "0",
      reversedPoints: "0",
      expectedNetPoints: "0",
      observedNetPoints: "0",
    };
    const fetcher = vi.fn().mockResolvedValue(Response.json(value));
    await expect(
      createMerchantImportReconciliationClient(
        async () => "token",
        "store",
        fetcher,
      )(input),
    ).resolves.toEqual(value);
  },
);
