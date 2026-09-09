import { expect, it, vi } from "vitest";
import { createMerchantImportsAction } from "../../../../packages/shopify-app/app/merchant-imports-action.server";
import {
  createMerchantImportReconciliationClient,
  createMerchantImportsClient,
} from "../../../../packages/shopify-app/app/merchant-imports-client";
import { weleticApiJson } from "../../../../packages/shopify-app/app/weletic-api.server";
vi.mock("../../../../packages/shopify-app/app/weletic-api.server", () => ({
  weleticApiJson: vi.fn().mockResolvedValue({}),
  WeleticGatewayError: class extends Error {},
}));
const source = { format: "json", sha256: "a".repeat(64) };
const generation = { expectedInstallationGeneration: "generation" };
const revision = { expectedRevision: "b".repeat(64) };
const operations = [
  {
    request: { operation: "inspect", ...generation, source },
    sourceBase64: "W10=",
  },
  {
    request: { operation: "stage", ...generation, ...revision, source },
    sourceBase64: "W10=",
  },
  ...["reconcile", "commit", "rollback"].map((operation) => ({
    request: { operation, ...generation, ...revision, sourceId: "source" },
  })),
];
it.each(operations)(
  "gives whole-source operations gateway headroom: $request.operation",
  async (body) => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      vi.mocked(weleticApiJson).mockClear();
      const authenticate = vi.fn(async (_request, callback) =>
        callback({ actor: { storeId: "store" } }),
      );
      await createMerchantImportsAction(authenticate)(
        new Request("https://app.example/api/merchant/imports", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
      expect(weleticApiJson).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(35_000);
    } finally {
      timeout.mockRestore();
    }
  },
);
it.each([
  { operation: "context" },
  { operation: "status", ...generation, sourceId: "source" },
  { operation: "history", ...generation },
])("retains the short gateway deadline for $operation", async (request) => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  try {
    const authenticate = vi.fn(async (_request, callback) =>
      callback({ actor: { storeId: "store" } }),
    );
    await createMerchantImportsAction(authenticate)(
      new Request("https://app.example/api/merchant/imports", {
        method: "POST",
        body: JSON.stringify({ request }),
      }),
    );
    expect(timeout).toHaveBeenCalledWith(8_000);
  } finally {
    timeout.mockRestore();
  }
});
it.each(["inspect", "stage", "reconcile"])(
  "bounds the %s browser request at 40 seconds without retry",
  async (operation) => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(() => new Promise<Response>(() => {}));
      const pending =
        operation === "reconcile"
          ? createMerchantImportReconciliationClient(
              async () => "token",
              "store",
              fetcher,
            )({ operation, ...generation, ...revision, sourceId: "source" })
          : createMerchantImportsClient(
              async () => "token",
              "store",
              fetcher,
            )({
              request: {
                operation,
                ...generation,
                ...(operation === "stage" ? revision : {}),
                source,
              },
              sourceBase64: "W10=",
            });
      const rejected = expect(pending).rejects.toMatchObject({
        code: "unavailable",
      });
      await vi.advanceTimersByTimeAsync(35_000);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const init = (
        fetcher.mock.calls as unknown as Array<[string, RequestInit]>
      )[0][1];
      expect(init.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(init.signal?.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);
