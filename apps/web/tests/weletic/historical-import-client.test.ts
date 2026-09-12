import { expect, it, vi } from "vitest";
import {
  createMerchantImportContextClient,
  createMerchantImportsClient,
} from "../../../../packages/shopify-app/app/merchant-imports-client";
it("loads import context using a fresh token and no supplied store authority", async () => {
  const context = {
    storeId: "store",
    installationGeneration: "generation",
    configure: true,
  };
  const token = vi
    .fn()
    .mockResolvedValueOnce("one")
    .mockResolvedValueOnce("two");
  const fetcher = vi
    .fn()
    .mockImplementation(async () => Response.json(context));
  const client = createMerchantImportContextClient(token, fetcher);
  expect(await client()).toEqual(context);
  await client();
  expect(
    fetcher.mock.calls.map((call) => call[1].headers.Authorization),
  ).toEqual(["Bearer one", "Bearer two"]);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/merchant/imports",
    expect.objectContaining({
      body: JSON.stringify({ request: { operation: "context" } }),
      credentials: "omit",
      cache: "no-store",
    }),
  );
});
it.each([
  {},
  { storeId: "store", installationGeneration: "generation", configure: false },
  {
    storeId: "store",
    installationGeneration: "generation",
    configure: true,
    customerEmail: "private@example.test",
  },
])("rejects malformed context without retrying", async (value) => {
  const fetcher = vi.fn().mockImplementation(async () => Response.json(value));
  await expect(
    createMerchantImportContextClient(async () => "token", fetcher)(),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
const source = { sha256: "a".repeat(64), format: "json" };
const input = {
  request: {
    operation: "stage",
    expectedInstallationGeneration: "generation",
    expectedRevision: "b".repeat(64),
    source,
  },
  sourceBase64: "W10=",
};
const response = {
  storeId: "store",
  installationGeneration: "generation",
  revision: "c".repeat(64),
  sourceId: "source",
  source,
  status: "preview",
  rowCount: 1,
  totalOpeningBalance: "10",
};
it("accepts a birthday-conflict preview with no birthday values or balances", async () => {
  const result = {
    storeId: "store",
    installationGeneration: "generation",
    revision: "b".repeat(64),
    source,
    rowCount: 1,
    totalOpeningBalance: "10",
    valid: false,
    rows: [
      {
        rowNumber: 1,
        issues: ["birthday_conflict"],
        wouldEnroll: false,
        balanceBefore: null,
        balanceAfter: null,
      },
    ],
  };
  const fetcher = vi.fn().mockResolvedValue(Response.json(result));
  await expect(
    createMerchantImportsClient(
      async () => "token",
      "store",
      fetcher,
    )({
      sourceBase64: "W10=",
      request: {
        operation: "inspect",
        expectedInstallationGeneration: "generation",
        source,
      },
    }),
  ).resolves.toEqual(result);
});
it("uses fresh bearer tokens without cookies or automatic retries", async () => {
  const token = vi
    .fn()
    .mockResolvedValueOnce("one")
    .mockResolvedValueOnce("two");
  const fetcher = vi
    .fn()
    .mockImplementation(async () => Response.json(response));
  const client = createMerchantImportsClient(token, "store", fetcher);
  await client(input);
  await client(input);
  expect(
    fetcher.mock.calls.map((call) => call[1].headers.Authorization),
  ).toEqual(["Bearer one", "Bearer two"]);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/merchant/imports",
    expect.objectContaining({ credentials: "omit", cache: "no-store" }),
  );
});
it.each([400, 401, 403, 409, 503])("does not retry HTTP %s", async (status) => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status }));
  await expect(
    createMerchantImportsClient(async () => "token", "store", fetcher)(input),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects another store's acknowledgement", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ ...response, storeId: "other" }));
  await expect(
    createMerchantImportsClient(async () => "token", "store", fetcher)(input),
  ).rejects.toMatchObject({ code: "unavailable" });
});
it("rejects injected authority before requesting a token", async () => {
  const token = vi.fn();
  const fetcher = vi.fn();
  await expect(
    createMerchantImportsClient(
      token,
      "store",
      fetcher,
    )({ ...input, actor: "forged" }),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(token).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
