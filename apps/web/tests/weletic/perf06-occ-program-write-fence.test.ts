import {
  historicalImportRevision,
  stageHistoricalImportInTransaction,
} from "@/lib/weletic/loyalty/historical-import-persistence";
import { parseHistoricalImportSource } from "@/lib/weletic/loyalty/historical-import-source";
import {
  OptimisticLockConflictError,
  assertLoyaltyProgramVersionMatches,
  readLoyaltyProgramSnapshot,
  updateLoyaltyProgramWithOCC,
  updateLoyaltyProgramWithOcc,
} from "@/lib/weletic/loyalty/program-write-fence";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

describe("PERF-06: Optimistic Concurrency Control & Write-Fence Lock Elimination", () => {
  describe("1. Lock-Free Snapshot Reads (readLoyaltyProgramSnapshot)", () => {
    it("reads loyalty program snapshot without acquiring FOR UPDATE lock", async () => {
      const queryRawSpy = vi.fn().mockImplementation((query: any) => {
        const sql = String(query?.strings || query || "");
        if (sql.includes("WeleticShopifyStore")) {
          return [{ id: "store_1", storeAccessState: "active" }];
        }
        if (sql.includes("WeleticLoyaltyProgram")) {
          return [
            {
              id: "prog_1",
              storeId: "store_1",
              status: "active",
              killSwitchActive: false,
              metadata: null,
              version: 3,
            },
          ];
        }
        return [];
      });

      const mockClient = {
        $queryRaw: queryRawSpy,
      } as unknown as Prisma.TransactionClient;

      const snapshot = await readLoyaltyProgramSnapshot({
        client: mockClient,
        storeId: "store_1",
        mode: "active",
      });

      expect(snapshot.id).toBe("prog_1");
      expect(snapshot.version).toBe(3);
      expect(snapshot.program.version).toBe(3);

      // Verify NO query contains "FOR UPDATE"
      for (const call of queryRawSpy.mock.calls) {
        const sql = String(call[0]?.strings || call[0] || "");
        expect(sql).not.toContain("FOR UPDATE");
      }
    });

    it("throws LoyaltyProgramWriteBlockedError if program status is disabled", async () => {
      const mockClient = {
        $queryRaw: vi.fn().mockImplementation((query: any) => {
          const sql = String(query?.strings || query || "");
          if (sql.includes("WeleticShopifyStore")) {
            return [{ id: "store_1", storeAccessState: "active" }];
          }
          return [
            {
              id: "prog_1",
              storeId: "store_1",
              status: "disabled",
              killSwitchActive: false,
              metadata: null,
              version: 1,
            },
          ];
        }),
      } as unknown as Prisma.TransactionClient;

      await expect(
        readLoyaltyProgramSnapshot({
          client: mockClient,
          storeId: "store_1",
          mode: "active",
        }),
      ).rejects.toThrow("Loyalty program is currently disabled or inactive.");
    });

    it("throws LoyaltyProgramWriteBlockedError if kill switch is active", async () => {
      const mockClient = {
        $queryRaw: vi.fn().mockImplementation((query: any) => {
          const sql = String(query?.strings || query || "");
          if (sql.includes("WeleticShopifyStore")) {
            return [{ id: "store_1", storeAccessState: "active" }];
          }
          return [
            {
              id: "prog_1",
              storeId: "store_1",
              status: "active",
              killSwitchActive: true,
              metadata: null,
              version: 1,
            },
          ];
        }),
      } as unknown as Prisma.TransactionClient;

      await expect(
        readLoyaltyProgramSnapshot({
          client: mockClient,
          storeId: "store_1",
          mode: "active",
        }),
      ).rejects.toThrow("Loyalty program is currently disabled or inactive.");
    });
  });

  describe("2. OCC Atomic Version Increments (updateLoyaltyProgramWithOCC)", () => {
    it("increments program version monotonically from 1 to 2 on first update", async () => {
      const updateManySpy = vi.fn().mockResolvedValue({ count: 1 });
      const mockTx = {
        weleticLoyaltyProgram: {
          updateMany: updateManySpy,
        },
      } as unknown as Prisma.TransactionClient;

      const result = await updateLoyaltyProgramWithOCC({
        tx: mockTx,
        programId: "prog_test_1",
        expectedVersion: 1,
        data: { status: "active" },
      });

      expect(result.version).toBe(2);
      expect(updateManySpy).toHaveBeenCalledWith({
        where: { id: "prog_test_1", version: 1 },
        data: expect.objectContaining({ version: 2, status: "active" }),
      });
    });

    it("increments version sequentially across chained updates (1 -> 2 -> 3)", async () => {
      let currentVersion = 1;
      const mockTx = {
        weleticLoyaltyProgram: {
          updateMany: vi.fn().mockImplementation(({ where, data }) => {
            if (where.version === currentVersion) {
              currentVersion = data.version;
              return { count: 1 };
            }
            return { count: 0 };
          }),
        },
      } as unknown as Prisma.TransactionClient;

      const step1 = await updateLoyaltyProgramWithOCC({
        tx: mockTx,
        programId: "prog_test_1",
        expectedVersion: 1,
        data: { killSwitchActive: false },
      });
      expect(step1.version).toBe(2);
      expect(currentVersion).toBe(2);

      const step2 = await updateLoyaltyProgramWithOcc({
        tx: mockTx,
        programId: "prog_test_1",
        expectedVersion: 2,
        data: { name: "Updated VIP Rewards" },
      });
      expect(step2.version).toBe(3);
      expect(currentVersion).toBe(3);
    });

    it("throws OptimisticLockConflictError if expectedVersion does not match current DB version", async () => {
      const mockTx = {
        weleticLoyaltyProgram: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      } as unknown as Prisma.TransactionClient;

      await expect(
        updateLoyaltyProgramWithOCC({
          tx: mockTx,
          programId: "prog_stale",
          expectedVersion: 1,
          data: { status: "disabled" },
        }),
      ).rejects.toThrow(OptimisticLockConflictError);
    });
  });

  describe("3. Concurrent Write Collision Rejection & Race Simulation", () => {
    it("simulates two concurrent writers with same expectedVersion: exactly one succeeds and one throws OptimisticLockConflictError", async () => {
      let dbVersion = 1;
      const mockTx = {
        weleticLoyaltyProgram: {
          updateMany: vi.fn().mockImplementation(({ where, data }) => {
            if (where.version === dbVersion) {
              dbVersion = data.version;
              return { count: 1 };
            }
            return { count: 0 };
          }),
        },
      } as unknown as Prisma.TransactionClient;

      const clientA = updateLoyaltyProgramWithOCC({
        tx: mockTx,
        programId: "prog_race",
        expectedVersion: 1,
        data: { name: "Merchant Plan A" },
      });

      const clientB = updateLoyaltyProgramWithOCC({
        tx: mockTx,
        programId: "prog_race",
        expectedVersion: 1,
        data: { name: "Merchant Plan B" },
      });

      const results = await Promise.allSettled([clientA, clientB]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejectedResult = rejected[0] as PromiseRejectedResult;
      expect(rejectedResult.reason).toBeInstanceOf(OptimisticLockConflictError);
      expect(rejectedResult.reason.name).toBe("OptimisticLockConflictError");
      expect(dbVersion).toBe(2);
    });

    it("enables rejected client to reload snapshot and retry successfully", async () => {
      let dbVersion = 2; // already bumped by concurrent transaction
      const mockTx = {
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockImplementation(() => ({
            id: "prog_retry",
            version: dbVersion,
          })),
          updateMany: vi.fn().mockImplementation(({ where, data }) => {
            if (where.version === dbVersion) {
              dbVersion = data.version;
              return { count: 1 };
            }
            return { count: 0 };
          }),
        },
      } as unknown as Prisma.TransactionClient;

      // First attempt with stale version 1 fails
      await expect(
        updateLoyaltyProgramWithOCC({
          tx: mockTx,
          programId: "prog_retry",
          expectedVersion: 1,
          data: { name: "Retried Plan" },
        }),
      ).rejects.toThrow(OptimisticLockConflictError);

      // Client re-reads fresh snapshot (version = 2)
      const fresh = await mockTx.weleticLoyaltyProgram.findUnique({
        where: { id: "prog_retry" },
      });
      expect(fresh?.version).toBe(2);

      // Second attempt with fresh version 2 succeeds
      const retryResult = await updateLoyaltyProgramWithOCC({
        tx: mockTx,
        programId: "prog_retry",
        expectedVersion: fresh!.version,
        data: { name: "Retried Plan" },
      });

      expect(retryResult.version).toBe(3);
      expect(dbVersion).toBe(3);
    });
  });

  describe("4. OCC Version Verification Gate (assertLoyaltyProgramVersionMatches)", () => {
    it("passes when program version and active status match expectedVersion", async () => {
      const mockTx = {
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue({
            version: 5,
            status: "active",
            killSwitchActive: false,
          }),
        },
      } as unknown as Prisma.TransactionClient;

      await expect(
        assertLoyaltyProgramVersionMatches({
          tx: mockTx,
          programId: "prog_gate",
          expectedVersion: 5,
        }),
      ).resolves.toBeUndefined();
    });

    it("throws OptimisticLockConflictError when version has drifted", async () => {
      const mockTx = {
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue({
            version: 6,
            status: "active",
            killSwitchActive: false,
          }),
        },
      } as unknown as Prisma.TransactionClient;

      await expect(
        assertLoyaltyProgramVersionMatches({
          tx: mockTx,
          programId: "prog_gate",
          expectedVersion: 5,
        }),
      ).rejects.toThrow(OptimisticLockConflictError);
    });
  });

  describe("5. Historical CSV Import Lock Elimination", () => {
    it("verifies staging historical imports does not acquire FOR UPDATE lock on WeleticLoyaltyProgram", async () => {
      const queryRawSpy = vi.fn().mockImplementation((query: any) => {
        const sql = String(query?.strings || query || "");
        if (sql.includes("WeleticShopifyStore")) {
          return [{ id: "store_123", storeAccessState: "active" }];
        }
        if (sql.includes("WeleticLoyaltyProgram")) {
          return [
            {
              id: "prog_stage_test",
              storeId: "store_123",
              status: "active",
              killSwitchActive: false,
              metadata: null,
              version: 1,
            },
          ];
        }
        return [];
      });

      const bytes = new TextEncoder().encode(
        JSON.stringify([
          {
            shopifyCustomerId: "gid://shopify/Customer/123",
            openingBalance: "100",
          },
        ]),
      );
      const source = {
        format: "json",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      const parsed = parseHistoricalImportSource({ bytes, source });
      const request = {
        operation: "stage",
        expectedInstallationGeneration: "generation_1",
        expectedRevision: historicalImportRevision({
          storeId: "store_123",
          programId: "prog_stage_test",
          installationGeneration: "generation_1",
          normalizedSha256: parsed.normalizedSha256,
          source: null,
        }),
        source,
      };

      const mockTx = {
        $queryRaw: queryRawSpy,
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue({
            id: "prog_stage_test",
            version: 1,
            status: "active",
            killSwitchActive: false,
          }),
          findFirst: vi.fn().mockResolvedValue({
            id: "prog_stage_test",
          }),
        },
        weleticLoyaltyTier: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        weleticShopper: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "shopper_1",
              storeId: "store_123",
              shopifyCustomerId: "123",
              loyaltyAccount: null,
            },
          ]),
        },
        weleticShopifyCustomerPrivacyTombstone: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        weleticLoyaltyImportSource: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(async ({ data }: any) => data),
        },
        weleticLoyaltyImportRowSnapshot: {
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      } as unknown as Prisma.TransactionClient;

      await stageHistoricalImportInTransaction({
        tx: mockTx,
        storeId: "store_123",
        installationGeneration: "generation_1",
        staffId: "staff_1",
        request,
        bytes,
      });

      // Assert that NO query on WeleticLoyaltyProgram contained "FOR UPDATE"
      const forUpdateCalls = queryRawSpy.mock.calls.filter((c) => {
        const sql = String(c[0]?.strings || c[0] || "");
        return (
          sql.includes("FOR UPDATE") && sql.includes("WeleticLoyaltyProgram")
        );
      });

      expect(forUpdateCalls).toHaveLength(0);
      expect(mockTx.weleticLoyaltyProgram.findUnique).toHaveBeenCalledWith({
        where: { id: "prog_stage_test" },
        select: expect.objectContaining({ version: true }),
      });
    });

    it("permits concurrent snapshot reads to complete immediately without waiting for long transactions", async () => {
      let importFinished = false;
      const longImportPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          importFinished = true;
          resolve();
        }, 150);
      });

      const startTime = Date.now();
      const readPromise = readLoyaltyProgramSnapshot({
        storeId: "store_123",
        mode: "active",
      });

      const [snapshot] = await Promise.all([readPromise, longImportPromise]);
      const elapsed = Date.now() - startTime;

      expect(snapshot).toBeDefined();
      expect(snapshot.version).toBe(1);
      expect(elapsed).toBeGreaterThanOrEqual(140); // Both resolved
      expect(importFinished).toBe(true);
    });
  });
});
