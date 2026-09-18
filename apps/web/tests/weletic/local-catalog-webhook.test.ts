import { afterEach, describe, expect, it, vi } from "vitest";
import { localCatalogWebhookResponse } from "../../lib/weletic/shopify/local-catalog-webhook";

describe("local catalog acknowledgement budget", () => {
  afterEach(() => vi.useRealTimers());
  it("returns successful completed work without waiting for the deadline", async () => {
    vi.useFakeTimers();
    const retain = vi.fn();
    const response = await localCatalogWebhookResponse(
      Promise.resolve(new Response("complete")),
      retain,
    );
    expect(response.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
    await retain.mock.calls[0][0];
  });
  it("keeps rejected bookkeeping retryable and consumes background rejection", async () => {
    const retain = vi.fn();
    const response = await localCatalogWebhookResponse(
      Promise.reject(new Error("database unavailable")),
      retain,
    );
    expect(response.status).toBe(503);
    await expect(retain.mock.calls[0][0]).resolves.toBeUndefined();
  });
  it("retains work after its response budget expires", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const processing = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const retain = vi.fn();
    const result = localCatalogWebhookResponse(processing, retain);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await result).status).toBe(503);
    finish(new Response("done"));
    await retain.mock.calls[0][0];
    expect(vi.getTimerCount()).toBe(0);
  });
});
