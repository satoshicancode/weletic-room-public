import {
  historicalImportExecutionRequestSchema,
  verifyHistoricalImportExecutionResponse,
} from "@/lib/weletic/loyalty/historical-import-contract";
import { expect, it, vi } from "vitest";
import { createMerchantImportExecutionClient } from "../../../../packages/shopify-app/app/merchant-imports-client";
import { createMerchantJsonPost } from "../../../../packages/shopify-app/app/staff-access-client";
const request = {
  operation: "commit",
  sourceId: "source",
  expectedInstallationGeneration: "g1",
  expectedRevision: "a".repeat(64),
};
const response = {
  operation: "commit",
  sourceId: "source",
  storeId: "store",
  installationGeneration: "g1",
  status: "committing",
};
it.each(["commit", "rollback"] as const)(
  "validates and sends only revision-fenced %s with a fresh session token",
  async (operation) => {
    const token = vi.fn().mockResolvedValue("session-token");
    const result = {
      ...response,
      operation,
      status: operation === "commit" ? "committing" : "rolling_back",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    const input = { ...request, operation };
    await expect(
      createMerchantImportExecutionClient(token, "store", fetcher)(input),
    ).resolves.toEqual(result);
    expect(token).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/merchant/imports",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: {
          Authorization: "Bearer session-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ request: input }),
      }),
    );
  },
);
it.each([
  { expectedRevision: undefined },
  { expectedInstallationGeneration: "x".repeat(65) },
  { sourceId: "" },
  { leaseId: "private" },
  { storeId: "foreign" },
  { operation: "redrive" },
])("rejects invalid write authority before transport: %j", async (changed) => {
  const input = { ...request, ...changed };
  expect(historicalImportExecutionRequestSchema.safeParse(input).success).toBe(
    false,
  );
  const fetcher = vi.fn();
  await expect(
    createMerchantImportExecutionClient(
      async () => "token",
      "store",
      fetcher,
    )(input),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  { sourceId: "foreign" },
  { installationGeneration: "old" },
  { operation: "rollback" },
  { status: "committed" },
  { leaseId: "private" },
])("rejects mismatched or private acknowledgements: %j", async (changed) => {
  expect(() =>
    verifyHistoricalImportExecutionResponse(request, {
      ...response,
      ...changed,
    }),
  ).toThrow();
});
it("rejects a foreign-store response and does not retry an ambiguous mutation", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ...response, storeId: "foreign" }), {
      status: 200,
    }),
  );
  await expect(
    createMerchantImportExecutionClient(
      async () => "token",
      "store",
      fetcher,
    )(request),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("allows the gateway window while retaining a bounded deadline and no retry", async () => {
  vi.useFakeTimers();
  try {
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const pending = createMerchantImportExecutionClient(
      async () => "token",
      "store",
      fetcher,
    )(request);
    const checked = expect(pending).resolves.toEqual(response);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
    resolve(new Response(JSON.stringify(response)));
    await checked;
    expect(vi.getTimerCount()).toBe(0);
    const stalled = createMerchantImportExecutionClient(
      async () => "token",
      "store",
      fetcher,
    )(request);
    const rejected = expect(stalled).rejects.toMatchObject({
      code: "unavailable",
    });
    await vi.advanceTimersByTimeAsync(40_000);
    await rejected;
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("preserves the shared 30-second default and stops late token acquisition", async () => {
  vi.useFakeTimers();
  try {
    let resolve!: (value: string) => void;
    const token = new Promise<string>((done) => {
      resolve = done;
    });
    const fetcher = vi.fn();
    const pending = createMerchantJsonPost(() => token, fetcher)(
      "/api/merchant/test",
      {},
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: "unavailable",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    resolve("late-token");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it.each([0, -1, 1.5, NaN, Infinity, 60_001])(
  "rejects an invalid transport deadline %s",
  (timeoutMs) => {
    expect(() =>
      createMerchantJsonPost(async () => "token", vi.fn(), { timeoutMs }),
    ).toThrow("invalid");
  },
);
