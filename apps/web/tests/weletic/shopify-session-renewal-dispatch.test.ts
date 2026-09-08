import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listDue: vi.fn(),
  publish: vi.fn(),
  persist: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { job: { createMany: mocks.persist } },
}));
vi.mock("@/lib/cron", () => ({
  qstash: { publishJSON: mocks.publish },
}));
vi.mock("@/lib/axiom/server", () => ({
  logger: { error: vi.fn(), flush: vi.fn() },
}));
vi.mock("@/lib/weletic/shopify/session-renewal", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/weletic/shopify/session-renewal")
    >();
  return { ...actual, listDueShopifySessionRenewals: mocks.listDue };
});

import { weleticShopifySessionRenewalSweepJob as sweep } from "@/lib/jobs/handlers/weletic-shopify-session-renewal-sweep-job";

// Exercise the production handler AND Job publication/recovery adapter. Only
// the page query, transport, and persistence edges are mocked in this suite.
describe("Shopify renewal sweep publication", () => {
  const input = {
    appId: "synthetic-renewal-app",
    scheduledAt: "2026-09-06T08:00:00.000Z",
  };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listDue.mockResolvedValue({ jobs: [], nextCursor: "store-100" });
    mocks.publish.mockResolvedValue({ messageId: "synthetic-message" });
    mocks.persist.mockResolvedValue({ count: 1 });
  });

  it("replays the same page with the same continuation deduplication ID", async () => {
    await sweep.execute(input);
    await sweep.execute(input);
    const [first, replay] = mocks.publish.mock.calls.map(
      ([request]) => request,
    );
    expect(first.body.payload).toEqual({ ...input, afterId: "store-100" });
    expect(first.deduplicationId).toMatch(
      /^[a-f0-9]{64},weletic-shopify-session-renewal-sweep-job$/,
    );
    expect(replay.deduplicationId).toBe(first.deduplicationId);
    expect(first.flowControl.parallelism).toBe(1);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("separates continuation IDs by app, sweep time, and cursor", async () => {
    await sweep.execute(input);
    await sweep.execute({ ...input, appId: "another-app" });
    await sweep.execute({ ...input, scheduledAt: "2026-09-06T08:01:00.000Z" });
    mocks.listDue.mockResolvedValue({ jobs: [], nextCursor: "store-200" });
    await sweep.execute(input);
    const ids = mocks.publish.mock.calls.map(
      ([request]) => request.deduplicationId,
    );
    expect(new Set(ids).size).toBe(4);
  });

  it("retains the continuation deduplication ID when publication is deferred", async () => {
    // A non-success response takes the actual durable recovery path without
    // timer retries, allowing assertions on exactly what recovery will replay.
    mocks.publish.mockResolvedValue({ error: "synthetic-unavailable" });
    await sweep.execute(input);
    const published = mocks.publish.mock.calls[0][0];
    const deferred = mocks.persist.mock.calls[0][0].data[0];
    expect(deferred.name).toBe(sweep.name);
    expect(deferred.payload).toEqual(published.body.payload);
    expect(`${deferred.options.deduplicationId},${sweep.name}`).toBe(
      published.deduplicationId,
    );
  });

  it("rejects when continuation publication and durable recovery both fail", async () => {
    mocks.publish.mockResolvedValue({ error: "synthetic-unavailable" });
    mocks.persist.mockRejectedValue(new Error("synthetic-db-unavailable"));
    await expect(sweep.execute(input)).rejects.toThrow(
      "synthetic-db-unavailable",
    );
  });

  it("does not advance when a leaf cannot be published or durably retained", async () => {
    mocks.listDue.mockResolvedValue({
      jobs: [{ ...input, storeId: "store-1", installationGeneration: "g1" }],
      nextCursor: "store-100",
    });
    mocks.publish.mockResolvedValue({ error: "synthetic-unavailable" });
    mocks.persist.mockRejectedValue(new Error("synthetic-db-unavailable"));
    await expect(sweep.execute(input)).rejects.toThrow(
      "synthetic-db-unavailable",
    );
    expect(
      mocks.publish.mock.calls.every(
        ([request]) =>
          request.body.name === "weletic-shopify-session-renewal-job",
      ),
    ).toBe(true);
  });

  it("does not publish a continuation after the final page", async () => {
    mocks.listDue.mockResolvedValue({ jobs: [], nextCursor: null });
    await sweep.execute(input);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
