import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsertCustomer: vi.fn(),
  getThreadByExternalId: vi.fn(),
  createThread: vi.fn(),
}));

vi.mock("@/lib/plain/client", () => ({
  plain: {
    getThreadByExternalId: mocks.getThreadByExternalId,
    createThread: mocks.createThread,
  },
}));
vi.mock("@/lib/plain/upsert-plain-customer", () => ({
  upsertPlainCustomer: mocks.upsertCustomer,
}));

import { createPlainThread } from "../../lib/plain/create-plain-thread";

describe("Plain thread external-id idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsertCustomer.mockResolvedValue({
      data: { customer: { id: "plain_customer_1" } },
    });
    mocks.getThreadByExternalId.mockResolvedValue({
      data: null,
      error: null,
    });
    mocks.createThread.mockResolvedValue({
      data: { id: "plain_thread_new" },
      error: null,
    });
  });

  it("reuses an existing provider thread instead of creating a duplicate", async () => {
    const existing = { id: "plain_thread_existing" };
    mocks.getThreadByExternalId.mockResolvedValueOnce({
      data: existing,
      error: null,
    });

    await expect(
      createPlainThread({
        user: {
          id: "user_1",
          name: "Owner",
          email: "owner@example.com",
        },
        externalId: "weletic-shopify-compliance-export:wcomp_1",
        title: "Export ready",
        components: [],
      }),
    ).resolves.toBe(existing);

    expect(mocks.getThreadByExternalId).toHaveBeenCalledWith({
      customerId: "plain_customer_1",
      externalId: "weletic-shopify-compliance-export:wcomp_1",
    });
    expect(mocks.createThread).not.toHaveBeenCalled();
  });

  it("recovers an uncertain create by looking up the deterministic external id", async () => {
    const existing = { id: "plain_thread_race_winner" };
    mocks.getThreadByExternalId
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: existing, error: null });
    mocks.createThread.mockResolvedValueOnce({
      data: null,
      error: { message: "duplicate or uncertain result" },
    });

    await expect(
      createPlainThread({
        user: {
          id: "user_1",
          name: "Owner",
          email: "owner@example.com",
        },
        externalId: "weletic-shopify-compliance-export:wcomp_1",
        title: "Export ready",
        components: [],
      }),
    ).resolves.toBe(existing);

    expect(mocks.createThread).toHaveBeenCalledOnce();
    expect(mocks.getThreadByExternalId).toHaveBeenCalledTimes(2);
  });
});
