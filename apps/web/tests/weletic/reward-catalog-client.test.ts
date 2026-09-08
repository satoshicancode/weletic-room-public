import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMerchantRewardCatalogClient } from "../../../../packages/shopify-app/app/merchant-reward-catalog-client";
import { verifyRewardCatalogAcknowledgement } from "../../lib/weletic/loyalty/reward-catalog-acknowledgement";
import { createWorkspaceRewardCatalogClient } from "../../lib/weletic/loyalty/workspace-reward-catalog-client";
import { newRewardCatalogFields } from "../../ui/weletic/loyalty/reward-catalog-form";
const fields = {
  ...newRewardCatalogFields(),
  name: "Controlled reward",
  pointsCost: "9007199254740993",
};
const input = {
  expectedInstallationGeneration: "g1",
  expectedRevision: "a".repeat(64),
  rewardId: "reward-a",
  reward: fields,
};
const view = {
  storeId: "store-a",
  installationGeneration: "g1",
  shopCurrency: "JPY",
  revision: "b".repeat(64),
  affectedRewardId: "reward-a",
  capabilities: { configure: true },
  rewards: [
    {
      id: "reward-a",
      name: fields.name,
      rewardType: fields.rewardType,
      status: fields.status,
      fields,
      editUnavailableReason: null,
    },
  ],
};
const fetcher = vi.fn<typeof fetch>();
const token = vi.fn<() => Promise<string>>();
beforeEach(() => {
  vi.resetAllMocks();
  token.mockResolvedValue("synthetic");
  fetcher.mockImplementation(async () => Response.json(view));
});
afterEach(() => vi.useRealTimers());
const clients = {
  shopify: () => createMerchantRewardCatalogClient(token, fetcher),
  workspace: () => createWorkspaceRewardCatalogClient("workspace/a&b", fetcher),
};
describe.each(["shopify", "workspace"] as const)(
  "%s reward catalog transport",
  (kind) => {
    it("sends status-only containment and never retries an uncertain response", async () => {
      const containment = {
        expectedInstallationGeneration: input.expectedInstallationGeneration,
        expectedRevision: input.expectedRevision,
        rewardId: input.rewardId,
        status: "inactive" as const,
      };
      fetcher.mockResolvedValue(
        Response.json({
          ...view,
          shopCurrency: null,
          rewards: [
            {
              ...view.rewards[0],
              fields: null,
              editUnavailableReason: "legacy_configuration_requires_review",
            },
          ],
        }),
      );
      await clients[kind]().contain(containment);
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
        operation: "contain",
        input: containment,
      });
      fetcher.mockRejectedValue(new Error("Uncertain response"));
      await expect(clients[kind]().contain(containment)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it("preserves exact write fields and verifies the acknowledged reward", async () => {
      expect(await clients[kind]().save(input)).toEqual(view);
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
        operation: "save",
        input,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      fetcher.mockResolvedValue(
        Response.json({ ...view, affectedRewardId: "other" }),
      );
      await expect(clients[kind]().save(input)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it("reads privately with the correct authentication boundary", async () => {
      fetcher.mockImplementation(async () =>
        Response.json({ ...view, affectedRewardId: null }),
      );
      await clients[kind]().read();
      if (kind === "shopify") {
        expect(token).toHaveBeenCalledTimes(1);
        expect(fetcher).toHaveBeenCalledWith(
          "/api/merchant/reward-catalog",
          expect.objectContaining({
            method: "POST",
            credentials: "omit",
            cache: "no-store",
            headers: expect.objectContaining({
              Authorization: "Bearer synthetic",
            }),
          }),
        );
      } else {
        expect(token).not.toHaveBeenCalled();
        expect(fetcher).toHaveBeenCalledWith(
          "/api/weletic/reward-catalog?workspaceId=workspace%2Fa%26b",
          expect.objectContaining({
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
          }),
        );
        expect(fetcher.mock.calls[0][1]).not.toHaveProperty("body");
      }
    });
    it("rejects invalid input without fetching", async () => {
      await expect(
        clients[kind]().save({ ...input, expectedRevision: "bad" }),
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    });
    it.each([401, 403, 409, 503])("never retries HTTP %s", async (status) => {
      fetcher.mockResolvedValue(new Response("", { status }));
      await expect(clients[kind]().save(input)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it("times out an uncertain write once even if fetch ignores abort", async () => {
      vi.useFakeTimers();
      fetcher.mockImplementation(() => new Promise(() => {}));
      const pending = clients[kind]().save(input);
      const rejected = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(kind === "shopify" ? 30001 : 8001);
      await rejected;
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  },
);
describe("reward catalog acknowledgement", () => {
  it("acknowledges status-only containment without requiring editable legacy fields", () => {
    const request = {
      operation: "contain",
      input: {
        expectedInstallationGeneration: "g1",
        expectedRevision: input.expectedRevision,
        rewardId: "reward-a",
        status: "inactive",
      },
    };
    const legacy = {
      ...view,
      rewards: [
        {
          ...view.rewards[0],
          fields: null,
          status: "inactive",
          editUnavailableReason: "legacy_configuration_requires_review",
        },
      ],
    };
    expect(verifyRewardCatalogAcknowledgement(request, legacy)).toEqual(legacy);
    expect(() =>
      verifyRewardCatalogAcknowledgement(request, {
        ...legacy,
        rewards: [{ ...legacy.rewards[0], status: "active" }],
      }),
    ).toThrow();
    expect(() =>
      verifyRewardCatalogAcknowledgement(
        { ...request, input: { ...request.input, status: "active" } },
        legacy,
      ),
    ).toThrow();
  });
  it.each([
    { affectedRewardId: null },
    { installationGeneration: "old" },
    { rewards: [] },
    { rewards: [view.rewards[0], view.rewards[0]] },
    {
      rewards: [{ ...view.rewards[0], fields: { ...fields, pointsCost: "1" } }],
    },
    { rewards: [{ ...view.rewards[0], name: "wrong" }] },
  ])("fails closed for inconsistent data %j", (patch) => {
    expect(() =>
      verifyRewardCatalogAcknowledgement(
        { operation: "save", input },
        { ...view, ...patch },
      ),
    ).toThrow();
  });
  it("accepts normalized percentage decimals, not a changed value", () => {
    const reward = {
      ...fields,
      rewardType: "percentage_off",
      discountValue: "10.00",
    };
    const response = {
      ...view,
      rewards: [
        {
          ...view.rewards[0],
          rewardType: "percentage_off",
          fields: { ...reward, discountValue: "10" },
        },
      ],
    };
    expect(
      verifyRewardCatalogAcknowledgement(
        { operation: "save", input: { ...input, reward } },
        response,
      ),
    ).toEqual(response);
    expect(() =>
      verifyRewardCatalogAcknowledgement(
        { operation: "save", input: { ...input, reward } },
        {
          ...response,
          rewards: [
            {
              ...response.rewards[0],
              fields: { ...reward, discountValue: "11" },
            },
          ],
        },
      ),
    ).toThrow();
  });
});
