import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteExpiredPendingInstallations } from "../../lib/weletic/shopify/pending-installation-retention";

afterEach(() => vi.unstubAllEnvs());
describe("pending installation retention boundary", () => {
  it("uses bounded current-state deletion and the shorter current policy", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_FINANCIAL_RETENTION_DAYS", "10");
    const execute = vi.fn().mockResolvedValue(3);
    const query = vi
      .fn()
      .mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const now = new Date("2026-09-09T12:00:00Z");
    expect(
      await deleteExpiredPendingInstallations(
        { $executeRaw: execute, $queryRaw: query },
        { now, batchSize: 999 },
      ),
    ).toBe(3);
    const sql = query.mock.calls[0][0] as Prisma.Sql;
    expect(sql.values).toEqual([
      now,
      now,
      new Date("2026-08-30T12:00:00Z"),
      100,
    ]);
    expect(sql.sql).toContain("state = 'redacted'");
    for (const field of [
      "mappedStoreId",
      "installationGeneration",
      "authenticatedAt",
      "uninstalledAt",
    ])
      expect(sql.sql).toContain(`${field} IS NULL`);
    expect(sql.sql).toContain("NOT EXISTS");
    expect(sql.sql).toContain(
      "audit.pendingInstallationId = WeleticShopifyPendingInstallation.id",
    );
    expect(sql.sql).toContain("ORDER BY id ASC LIMIT");
    expect(sql.sql).toContain("FORCE INDEX (PRIMARY)");
    expect(sql.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect((execute.mock.calls[0][0] as Prisma.Sql).values.slice(0, 3)).toEqual(
      ["a", "b", "c"],
    );
  });
  it.each([NaN, Infinity, -Infinity])(
    "rejects invalid batch size %s before DB access",
    async (batchSize) => {
      const execute = vi.fn();
      await expect(
        deleteExpiredPendingInstallations(
          { $executeRaw: execute, $queryRaw: vi.fn() },
          { batchSize },
        ),
      ).rejects.toThrow("Invalid");
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it("rejects invalid clocks", async () => {
    const execute = vi.fn();
    await expect(
      deleteExpiredPendingInstallations(
        { $executeRaw: execute, $queryRaw: vi.fn() },
        { now: new Date(NaN) },
      ),
    ).rejects.toThrow("Invalid");
    expect(execute).not.toHaveBeenCalled();
  });
});
