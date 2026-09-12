import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantImportsAction } from "../../../../packages/shopify-app/app/merchant-imports-action.server";
import {
  createMerchantImportHistoryClient,
  createMerchantImportStatusClient,
} from "../../../../packages/shopify-app/app/merchant-imports-client";
import { weleticApiJson } from "../../../../packages/shopify-app/app/weletic-api.server";

vi.mock("../../../../packages/shopify-app/app/weletic-api.server", () => ({
  weleticApiJson: vi.fn(),
  WeleticGatewayError: class extends Error {},
}));
const input = {
  operation: "status",
  sourceId: "source",
  expectedInstallationGeneration: "generation",
};
const result = {
  sourceId: "source",
  storeId: "store",
  installationGeneration: "generation",
  sourceInstallationGeneration: "old-generation",
  revision: "a".repeat(64),
  status: "contained",
  rowCount: 2,
  totalOpeningBalance: "18446744073709551614",
  createdAt: "2026-09-01T00:00:00.000Z",
  completedAt: null,
  verification: "source_record_only",
};
const request = (value: unknown = { request: input }) =>
  new Request("https://app.example/api/merchant/imports", {
    method: "POST",
    body: JSON.stringify(value),
  });
const auth = vi
  .fn()
  .mockImplementation(async (_request, callback) =>
    callback({ actor: { storeId: "store" } }),
  );
const historyInput = {
  operation: "history",
  expectedInstallationGeneration: "generation",
};
const historyResult = {
  storeId: "store",
  installationGeneration: "generation",
  sources: [result],
  nextCursor: null,
};
it.each([
  ["source", "2026-09-01T00:00:00.000Z"],
  ["z", "2026-08-01T00:00:00.000Z"],
])(
  "rejects a replayed page not strictly before %s/%s",
  async (sourceId, createdAt) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(historyResult));
    await expect(
      createMerchantImportHistoryClient(
        async () => "token",
        "store",
        fetcher,
      )({ ...historyInput, before: { sourceId, createdAt } }),
    ).rejects.toMatchObject({ code: "unavailable" });
  },
);
it("checks normalized timestamps and byte-order ties rather than locale ordering", async () => {
  const page = {
    ...historyResult,
    sources: [
      { ...result, sourceId: "a" },
      { ...result, sourceId: "Z" },
    ],
  };
  const fetcher = vi.fn().mockImplementation(async () => Response.json(page));
  const client = createMerchantImportHistoryClient(
    async () => "token",
    "store",
    fetcher,
  );
  await expect(
    client({
      ...historyInput,
      before: { sourceId: "z", createdAt: "2026-09-01T00:00:00Z" },
    }),
  ).resolves.toEqual(page);
  page.sources.reverse();
  await expect(client(historyInput)).rejects.toMatchObject({
    code: "unavailable",
  });
});
it("forwards and validates a history page without upload", async () => {
  vi.mocked(weleticApiJson).mockResolvedValue(historyResult);
  const response = await createMerchantImportsAction(auth)(
    request({ request: historyInput }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(historyResult);
  const fetcher = vi.fn().mockResolvedValue(Response.json(historyResult));
  await expect(
    createMerchantImportHistoryClient(
      async () => "token",
      "store",
      fetcher,
    )(historyInput),
  ).resolves.toEqual(historyResult);
});
it.each([
  { storeId: "other" },
  { installationGeneration: "stale" },
  { sources: [{ ...result, storeId: "other" }] },
  { sources: [result, result] },
  { nextCursor: { sourceId: "unrelated", createdAt: result.createdAt } },
])("rejects substituted history or invalid pagination: %j", async (change) => {
  const value = { ...historyResult, ...change };
  vi.mocked(weleticApiJson).mockResolvedValue(value);
  expect(
    (
      await createMerchantImportsAction(auth)(
        request({ request: historyInput }),
      )
    ).status,
  ).toBe(503);
  const fetcher = vi.fn().mockResolvedValue(Response.json(value));
  await expect(
    createMerchantImportHistoryClient(
      async () => "token",
      "store",
      fetcher,
    )(historyInput),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(weleticApiJson).mockResolvedValue(result);
});
it("forwards actor-bound status without upload and returns exact source-record evidence", async () => {
  const response = await createMerchantImportsAction(auth)(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(result);
  expect(
    JSON.parse(vi.mocked(weleticApiJson).mock.calls[0][1]!.body as string),
  ).toEqual({ actor: { storeId: "store" }, request: input });
});
it.each([
  { sourceId: "other" },
  { storeId: "other" },
  { installationGeneration: "stale" },
  { totalOpeningBalance: 18446744073709551614 },
  { customerEmail: "private@example.test" },
  { verification: "reconciled" },
])(
  "rejects substituted or invalid status at both transport boundaries: %j",
  async (change) => {
    const value = { ...result, ...change };
    vi.mocked(weleticApiJson).mockResolvedValue(value);
    const response = await createMerchantImportsAction(auth)(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "imports_unavailable" });
    const fetcher = vi.fn().mockResolvedValue(Response.json(value));
    await expect(
      createMerchantImportStatusClient(
        async () => "token",
        "store",
        fetcher,
      )(input),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it("rejects scope injection or status uploads before authentication", async () => {
  for (const value of [
    { request: { ...input, storeId: "other" } },
    { request: input, sourceBase64: "W10=" },
  ]) {
    expect(
      (await createMerchantImportsAction(auth)(request(value))).status,
    ).toBe(400);
  }
  expect(auth).not.toHaveBeenCalled();
  expect(weleticApiJson).not.toHaveBeenCalled();
});
it("uses fresh tokens and omits cookies for status reads", async () => {
  const token = vi
    .fn()
    .mockResolvedValueOnce("one")
    .mockResolvedValueOnce("two");
  const fetcher = vi.fn().mockImplementation(async () => Response.json(result));
  const client = createMerchantImportStatusClient(token, "store", fetcher);
  expect(await client(input)).toEqual(result);
  await client(input);
  expect(
    fetcher.mock.calls.map((call) => call[1].headers.Authorization),
  ).toEqual(["Bearer one", "Bearer two"]);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/merchant/imports",
    expect.objectContaining({
      body: JSON.stringify({ request: input }),
      credentials: "omit",
      cache: "no-store",
    }),
  );
});
it.each([401, 403, 409, 503])(
  "never retries failed status reads: %s",
  async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status }));
    await expect(
      createMerchantImportStatusClient(
        async () => "token",
        "store",
        fetcher,
      )(input),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it("rejects invalid client requests before obtaining a token", async () => {
  const token = vi.fn();
  const fetcher = vi.fn();
  await expect(
    createMerchantImportStatusClient(
      token,
      "store",
      fetcher,
    )({ ...input, storeId: "other" }),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(token).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
