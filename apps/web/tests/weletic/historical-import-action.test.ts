import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantImportsAction } from "../../../../packages/shopify-app/app/merchant-imports-action.server";
import { weleticApiJson } from "../../../../packages/shopify-app/app/weletic-api.server";
vi.mock("../../../../packages/shopify-app/app/weletic-api.server", () => ({
  weleticApiJson: vi.fn(),
  WeleticGatewayError: class extends Error {},
}));
const source = { format: "json", sha256: "a".repeat(64) };
const input = {
  request: {
    operation: "inspect",
    expectedInstallationGeneration: "generation",
    source,
  },
  sourceBase64: "W10=",
};
const response = {
  storeId: "store",
  installationGeneration: "generation",
  revision: "b".repeat(64),
  source,
  rowCount: 1,
  totalOpeningBalance: "10",
  valid: true,
  rows: [
    {
      rowNumber: 1,
      issues: [],
      wouldEnroll: false,
      balanceBefore: "0",
      balanceAfter: "10",
    },
  ],
};
const request = (value: unknown = input) =>
  new Request("https://app.example/api/merchant/imports", {
    method: "POST",
    body: JSON.stringify(value),
  });
const auth = vi
  .fn()
  .mockImplementation(async (_request, callback) =>
    callback({ actor: { storeId: "store" } }),
  );
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(weleticApiJson).mockResolvedValue(response);
});
it("forwards the authenticated actor and unchanged upload to the signing client", async () => {
  const result = await createMerchantImportsAction(auth)(request());
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(response);
  expect(weleticApiJson).toHaveBeenCalledWith(
    "/api/internal/shopify/merchant/imports",
    expect.objectContaining({
      body: expect.any(String),
      signal: expect.any(AbortSignal),
    }),
  );
  expect(
    JSON.parse(vi.mocked(weleticApiJson).mock.calls[0][1]!.body as string),
  ).toEqual({ actor: { storeId: "store" }, ...input });
});
it.each(["commit", "rollback"] as const)(
  "forwards authenticated %s without exposing private worker controls",
  async (operation) => {
    const input = {
      request: {
        operation,
        sourceId: "source",
        expectedInstallationGeneration: "generation",
        expectedRevision: "a".repeat(64),
      },
    };
    const result = {
      operation,
      sourceId: "source",
      storeId: "store",
      installationGeneration: "generation",
      status: operation === "commit" ? "committing" : "rolling_back",
    };
    vi.mocked(weleticApiJson).mockResolvedValue(result);
    const reply = await createMerchantImportsAction(auth)(request(input));
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual(result);
    expect(
      JSON.parse(vi.mocked(weleticApiJson).mock.calls[0][1]!.body as string),
    ).toEqual({ actor: { storeId: "store" }, ...input });
  },
);
it("rejects wrong-phase and private execution acknowledgements from the backend", async () => {
  const input = {
    request: {
      operation: "commit",
      sourceId: "source",
      expectedInstallationGeneration: "generation",
      expectedRevision: "a".repeat(64),
    },
  };
  for (const changed of [
    { status: "rolling_back" },
    { leaseId: "private" },
    { storeId: "foreign" },
  ]) {
    vi.mocked(weleticApiJson).mockResolvedValue({
      operation: "commit",
      sourceId: "source",
      storeId: "store",
      installationGeneration: "generation",
      status: "committing",
      ...changed,
    });
    expect(
      (await createMerchantImportsAction(auth)(request(input))).status,
    ).toBe(503);
  }
});
it("forwards a context request without requiring an upload or prior generation", async () => {
  vi.mocked(weleticApiJson).mockResolvedValue({
    storeId: "store",
    installationGeneration: "generation",
    configure: true,
  });
  const reply = await createMerchantImportsAction(auth)(
    request({ request: { operation: "context" } }),
  );
  expect(reply.status).toBe(200);
  expect(
    JSON.parse(vi.mocked(weleticApiJson).mock.calls[0][1]!.body as string),
  ).toEqual({ actor: { storeId: "store" }, request: { operation: "context" } });
});
it.each([
  { ...response, storeId: "other" },
  { ...response, installationGeneration: "old" },
  { ...response, source: { ...source, sha256: "c".repeat(64) } },
  { ...response, rowCount: 2 },
  { ...response, valid: false },
  { ...response, totalOpeningBalance: "11" },
  {
    ...response,
    totalOpeningBalance: "9223372036854775808",
    rows: [
      {
        ...response.rows[0],
        balanceBefore: "-9223372036854775808",
        balanceAfter: "0",
      },
    ],
  },
  { ...response, rows: [{ ...response.rows[0], balanceAfter: "-1" }] },
  { ...response, rows: [{ ...response.rows[0], balanceBefore: "-0" }] },
  {
    ...response,
    rows: [{ ...response.rows[0], balanceAfter: "9223372036854775808" }],
  },
  { ...response, rows: [{ ...response.rows[0], rowNumber: 2 }] },
  { ...response, rows: [{ ...response.rows[0], customerId: "private" }] },
])(
  "rejects a contradictory or privacy-leaking acknowledgement",
  async (result) => {
    vi.mocked(weleticApiJson).mockResolvedValue(result);
    const reply = await createMerchantImportsAction(auth)(request());
    expect(reply.status).toBe(503);
    expect(await reply.json()).toEqual({ error: "imports_unavailable" });
    expect(weleticApiJson).toHaveBeenCalledTimes(1);
  },
);
it("rejects actor injection and unsupported methods before authentication", async () => {
  const handler = createMerchantImportsAction(auth);
  expect(
    (await handler(request({ ...input, actor: { storeId: "other" } }))).status,
  ).toBe(400);
  expect(
    (await handler(new Request("https://app.example/api/merchant/imports")))
      .status,
  ).toBe(405);
  expect(auth).not.toHaveBeenCalled();
});
it("requires staging acknowledgement to advance the revision", async () => {
  const stage = {
    ...input,
    request: {
      ...input.request,
      operation: "stage",
      expectedRevision: "b".repeat(64),
    },
  };
  vi.mocked(weleticApiJson).mockResolvedValue({
    storeId: "store",
    installationGeneration: "generation",
    revision: "b".repeat(64),
    rowCount: 1,
    totalOpeningBalance: "10",
    status: "preview",
    sourceId: "source",
    source,
  });
  expect((await createMerchantImportsAction(auth)(request(stage))).status).toBe(
    503,
  );
});
it("binds staging acknowledgement to the uploaded file", async () => {
  const stage = {
    ...input,
    request: {
      ...input.request,
      operation: "stage",
      expectedRevision: "b".repeat(64),
    },
  };
  const acknowledged = {
    storeId: "store",
    installationGeneration: "generation",
    revision: "d".repeat(64),
    rowCount: 1,
    totalOpeningBalance: "10",
    status: "preview",
    sourceId: "source",
    source,
  };
  vi.mocked(weleticApiJson).mockResolvedValue(acknowledged);
  expect((await createMerchantImportsAction(auth)(request(stage))).status).toBe(
    200,
  );
  vi.mocked(weleticApiJson).mockResolvedValue({
    ...acknowledged,
    source: { ...source, sha256: "e".repeat(64) },
  });
  expect((await createMerchantImportsAction(auth)(request(stage))).status).toBe(
    503,
  );
});
