import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceEarningRulesClient } from "../../lib/weletic/loyalty/workspace-earning-rules-client";
const fetcher = vi.fn<typeof fetch>();
const view = {
  storeId: "store-a",
  installationGeneration: "g1",
  programId: "program-a",
  revision: "a".repeat(64),
  affectedRuleId: "rule-a",
  rules: [],
  capabilities: { configure: true },
};
const input = {
  expectedInstallationGeneration: "g1",
  expectedRevision: view.revision,
  ruleId: "rule-a",
};
const client = () =>
  createWorkspaceEarningRulesClient("workspace/a&b", fetcher);
beforeEach(() => {
  vi.resetAllMocks();
  fetcher.mockImplementation(async () => Response.json(view));
});
afterEach(() => vi.useRealTimers());
describe("workspace earning-rule browser transport", () => {
  it("binds the explicit encoded workspace and uses same-origin private GET", async () => {
    expect(await client().read()).toEqual(view);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/weletic/earning-rules?workspaceId=workspace%2Fa%26b",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("body");
  });
  it("uses POST and checks retirement acknowledgement", async () => {
    expect(await client().retire(input)).toEqual(view);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      operation: "retire",
      input,
    });
    fetcher.mockResolvedValue(
      Response.json({ ...view, affectedRuleId: "other" }),
    );
    await expect(client().retire(input)).rejects.toThrow("acknowledgement");
  });
  it("rejects invalid inputs before network access", async () => {
    await expect(
      client().retire({ ...input, expectedInstallationGeneration: "" }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => createWorkspaceEarningRulesClient(" ", fetcher)).toThrow(
      "Workspace",
    );
  });
  it.each([401, 403, 409, 503])("does not retry HTTP %s", async (status) => {
    fetcher.mockResolvedValue(Response.json({}, { status }));
    await expect(client().retire(input)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["fetch", "body"])(
    "bounds a stalled %s without retry",
    async (stage) => {
      vi.useFakeTimers();
      if (stage === "fetch")
        fetcher.mockImplementation(() => new Promise(() => {}));
      else
        fetcher.mockResolvedValue({
          ok: true,
          json: () => new Promise(() => {}),
        } as Response);
      const pending = expect(client().retire(input)).rejects.toThrow(
        "uncertain",
      );
      await vi.advanceTimersByTimeAsync(8001);
      await pending;
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    },
  );
  it("rejects overbroad response fields", async () => {
    fetcher.mockResolvedValue(Response.json({ ...view, privateMetadata: {} }));
    await expect(client().read()).rejects.toThrow("acknowledgement");
  });
});
