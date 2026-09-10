import { defaultLoyaltyNudgeSettings } from "@/lib/weletic/loyalty/nudge-contract";
import { expect, it, vi } from "vitest";
import { createMerchantLoyaltyNudgeClient } from "../../../../packages/shopify-app/app/merchant-loyalty-nudges-client";

const response = {
  storeId: "store-1",
  installationGeneration: "generation-1",
  revision: "a".repeat(64),
  programConfigured: true,
  capabilities: { configure: true },
  settings: { ...defaultLoyaltyNudgeSettings() },
};
const save = {
  operation: "save" as const,
  expectedInstallationGeneration: response.installationGeneration,
  expectedRevision: response.revision,
  settings: response.settings,
};
it("uses fresh bearer tokens, no cookies, and no cache", async () => {
  const token = vi
    .fn()
    .mockResolvedValueOnce("one")
    .mockResolvedValueOnce("two");
  const fetcher = vi
    .fn()
    .mockImplementation(async () => Response.json(response));
  const client = createMerchantLoyaltyNudgeClient(token, fetcher);
  await client({ operation: "read" });
  await client({ operation: "read" });
  expect(
    fetcher.mock.calls.map((call) => call[1].headers.Authorization),
  ).toEqual(["Bearer one", "Bearer two"]);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/merchant/loyalty-nudges",
    expect.objectContaining({
      cache: "no-store",
      credentials: "omit",
      method: "POST",
    }),
  );
});
it.each([
  [401, "reauthenticate"],
  [403, "denied"],
  [409, "reload"],
  [503, "unavailable"],
])("does not retry failed %s saves", async (status, code) => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response("private detail", { status: status as number }),
    );
  await expect(
    createMerchantLoyaltyNudgeClient(async () => "token", fetcher)(save),
  ).rejects.toMatchObject({ code });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  { revision: response.revision },
  { installationGeneration: "foreign-generation" },
  { programConfigured: false },
  { capabilities: { configure: false } },
  { settings: { ...response.settings, launcherText: "Different" } },
])("rejects false save acknowledgements: %j", async (patch) => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json({ ...response, revision: "b".repeat(64), ...patch }),
    );
  await expect(
    createMerchantLoyaltyNudgeClient(async () => "token", fetcher)(save),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("accepts the exact changed acknowledgement", async () => {
  const saved = { ...response, revision: "b".repeat(64) };
  const fetcher = vi.fn().mockResolvedValue(Response.json(saved));
  await expect(
    createMerchantLoyaltyNudgeClient(async () => "token", fetcher)(save),
  ).resolves.toEqual(saved);
});
