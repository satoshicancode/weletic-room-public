import { describe, expect, it, vi } from "vitest";
import {
  createMerchantFlowGrantsClient,
  newFlowGrantAttemptId,
} from "../../../../packages/shopify-app/app/merchant-flow-grants-client";
const attemptId = "a".repeat(64);
const create = {
  operation: "create",
  attemptId,
  input: {
    allowCredit: true,
    allowDebit: false,
    maxAbsolutePointsPerAction: "100",
    absolutePointsBudget: "1000",
    expiresAt: "2030-01-01T00:00:00.000Z",
    expectedRevision: 0,
    expectedInstallationGeneration: "g1",
  },
};
const grantId = `wflowgrant_${"a".repeat(20)}`;
describe("embedded Flow grant browser transport", () => {
  it("generates a 256-bit recovery nonce before a write", () => {
    const a = newFlowGrantAttemptId();
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(newFlowGrantAttemptId()).not.toBe(a);
  });
  it("fetches fresh bearer tokens and preserves the caller's attempt ID", async () => {
    const token = vi.fn().mockResolvedValue("synthetic-token");
    const fetcher = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          Response.json({ id: grantId, revision: 1, revokedAt: null }),
        ),
      );
    const client = createMerchantFlowGrantsClient(token, fetcher);
    await client.write(create);
    expect(token).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(create);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      headers: { Authorization: "Bearer synthetic-token" },
    });
  });
  it("does not retry a network-ambiguous write", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("lost response"));
    await expect(
      createMerchantFlowGrantsClient(async () => "token", fetcher).write(
        create,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects a wrong revoke acknowledgment", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        id: `wflowgrant_${"z".repeat(20)}`,
        revision: 2,
        revokedAt: "2026-09-20T00:00:00.000Z",
      }),
    );
    await expect(
      createMerchantFlowGrantsClient(async () => "token", fetcher).write({
        operation: "revoke",
        attemptId,
        input: {
          grantId,
          expectedRevision: 1,
          expectedInstallationGeneration: "g1",
        },
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  it("recovers via a separate read and rejects stale-generation responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        grants: [],
        nextCursor: null,
        installationGeneration: "g2",
        observedAt: "2026-09-20T00:00:00.000Z",
      }),
    );
    await expect(
      createMerchantFlowGrantsClient(async () => "token", fetcher).list({
        approvalRequestId: attemptId,
        expectedInstallationGeneration: "g1",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      operation: "list",
      input: { approvalRequestId: attemptId },
    });
  });
  it("rejects missing attempt IDs before token or network access", async () => {
    const token = vi.fn(),
      fetcher = vi.fn();
    await expect(
      createMerchantFlowGrantsClient(token, fetcher).write({
        operation: "create",
        input: create.input,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
