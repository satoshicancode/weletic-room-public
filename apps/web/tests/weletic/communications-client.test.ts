import { afterEach, expect, it, vi } from "vitest";
import { createMerchantCommunicationsClient } from "../../../../packages/shopify-app/app/merchant-communications-client";

const response = {
  storeId: "fixture-store",
  installationGeneration: "fixture-generation",
  revision: "a".repeat(64),
  capabilities: { configure: true },
  deliveryIntegration: "not_connected",
  policies: [],
};
const template = {
  subject: "Hello",
  heading: "Update",
  body: "Points",
  actionLabel: "View",
};
const policy = {
  journey: "birthday" as const,
  enabled: false,
  templates: { en: template, ja: template, vi: template },
};
const save = {
  operation: "save" as const,
  expectedInstallationGeneration: response.installationGeneration,
  expectedRevision: response.revision,
  policy,
};
afterEach(() => vi.useRealTimers());

it("obtains a fresh token for each call without browser credentials or cache", async () => {
  const token = vi
    .fn()
    .mockResolvedValueOnce("token-one")
    .mockResolvedValueOnce("token-two");
  const fetcher = vi
    .fn()
    .mockImplementation(async () => Response.json(response));
  const client = createMerchantCommunicationsClient(token, fetcher);
  await client({ operation: "read" });
  await client({ operation: "read" });
  expect(token).toHaveBeenCalledTimes(2);
  expect(
    fetcher.mock.calls.map((call) => call[1].headers.Authorization),
  ).toEqual(["Bearer token-one", "Bearer token-two"]);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/merchant/communications",
    expect.objectContaining({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      body: JSON.stringify({ operation: "read" }),
    }),
  );
});
it.each([
  [401, "reauthenticate"],
  [403, "denied"],
  [409, "reload"],
  [500, "unavailable"],
])("does not retry a failed %s save", async (status, code) => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response("private", { status: status as number }));
  const client = createMerchantCommunicationsClient(
    vi.fn().mockResolvedValue("token"),
    fetcher,
  );
  await expect(client(save)).rejects.toMatchObject({ code });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects a stale success acknowledgement without retrying", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ ...response, policies: [policy] }));
  const client = createMerchantCommunicationsClient(
    vi.fn().mockResolvedValue("token"),
    fetcher,
  );
  await expect(client(save)).rejects.toMatchObject({ code: "unavailable" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects injected authority before requesting a token", async () => {
  const token = vi.fn();
  const fetcher = vi.fn();
  const client = createMerchantCommunicationsClient(token, fetcher);
  await expect(
    client({ ...save, storeId: "another-store" } as any),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(token).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it("times out ambiguous transport once and aborts it", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation(() => new Promise(() => {}));
  const client = createMerchantCommunicationsClient(
    vi.fn().mockResolvedValue("token"),
    fetcher,
  );
  const result = expect(client(save)).rejects.toMatchObject({
    code: "unavailable",
  });
  await vi.advanceTimersByTimeAsync(30_000);
  await result;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
});
