import {
  historicalImportRevision,
  inspectHistoricalImportSourceInTransaction,
  stageHistoricalImportInTransaction,
} from "@/lib/weletic/loyalty/historical-import-persistence";
import { parseHistoricalImportSource } from "@/lib/weletic/loyalty/historical-import-source";
import {
  LoyaltyProgramWriteBlockedError,
  OptimisticLockConflictError,
  assertLoyaltyProgramVersionMatches,
  readLoyaltyProgramSnapshot,
  updateLoyaltyProgramWithOCC,
  updateLoyaltyProgramWithOcc,
  withLoyaltyProgramRowLock,
} from "@/lib/weletic/loyalty/program-write-fence";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

describe("PERF-06 Adversarial Challenger: Concurrency Collision & Lock-Free Invariants", () => {
  describe("1. Concurrency Collision Stress: Simultaneous Writes with Identical Version", () => {
    it("simulates 10 simultaneous writers with same expectedVersion: exactly 1 succeeds, 9 fail with OptimisticLockConflictError", async () => {
      let dbVersion = 1;
      const updateManySpy = vi.fn().mockImplementation(({ where, data }: any) => {
        if (where.version === dbVersion) {
          dbVersion = data.version;
          return Promise.resolve({ count: 1 });
        }
        return Promise.resolve({ count: 0 });
      });

      const mockTx = {
        weleticLoyaltyProgram: {
          updateMany: updateManySpy,
        },
      } as unknown as Prisma.TransactionClient;

      const programId = "prog_concurrent_10";
      const initialVersion = 1;
      const workerCount = 10;

      const workers = Array.from({ length: workerCount }, (_, i) =>
        updateLoyaltyProgramWithOCC({
          tx: mockTx,
          programId,
          expectedVersion: initialVersion,
          data: { name: `Worker-${i}` },
        }),
      );

      const results = await Promise.allSettled(workers);
      const successes = results.filter((r) => r.status === "fulfilled");
      const failures = results.filter((r) => r.status === "rejected");

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(workerCount - 1);
      expect(dbVersion).toBe(2);

      // Verify all failures are OptimisticLockConflictError with correct metadata
      for (const failure of failures) {
        const error = (failure as PromiseRejectedResult).reason;
        expect(error).toBeInstanceOf(OptimisticLockConflictError);
        expect(error.name).toBe("OptimisticLockConflictError");
        expect(error.programId).toBe(programId);
        expect(error.expectedVersion).toBe(initialVersion);
      }
    });

    it("simulates 25 simultaneous writers under an optimistic retry loop: all 25 succeed sequentially and monotonically", async () => {
      let currentDbVersion = 1;
      const programId = "prog_retry_25";

      const mockTx = {
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockImplementation(() =>
            Promise.resolve({
              id: programId,
              version: currentDbVersion,
              status: "active",
              killSwitchActive: false,
            }),
          ),
          updateMany: vi.fn().mockImplementation(({ where, data }: any) => {
            if (where.version === currentDbVersion) {
              currentDbVersion = data.version;
              return Promise.resolve({ count: 1 });
            }
            return Promise.resolve({ count: 0 });
          }),
        },
      } as unknown as Prisma.TransactionClient;

      // Each worker performs an OCC write with retry on conflict
      async function executeWithRetry(workerId: number, maxRetries = 50) {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          const snapshot = await mockTx.weleticLoyaltyProgram.findUnique({
            where: { id: programId },
          });
          const expectedVersion = snapshot!.version;
          try {
            const res = await updateLoyaltyProgramWithOCC({
              tx: mockTx,
              programId,
              expectedVersion,
              data: { name: `Batch-${workerId}-try-${attempt}` },
            });
            return res;
          } catch (err) {
            if (err instanceof OptimisticLockConflictError) {
              // Yield briefly to simulate backoff
              await new Promise((r) => setTimeout(r, 1));
              continue;
            }
            throw err;
          }
        }
        throw new Error(`Worker ${workerId} exceeded max retries`);
      }

      const workers = Array.from({ length: 25 }, (_, i) => executeWithRetry(i));
      const results = await Promise.all(workers);

      expect(results).toHaveLength(25);
      // After 25 increments starting from 1, dbVersion must be 1 + 25 = 26
      expect(currentDbVersion).toBe(26);
    });
  });

  describe("2. Version Monotonicity & Drift Rejection", () => {
    it("guarantees monotonic version progression v -> v+1 -> v+2 across chained updates", async () => {
      let dbVersion = 10;
      const mockTx = {
        weleticLoyaltyProgram: {
          updateMany: vi.fn().mockImplementation(({ where, data }: any) => {
            if (where.version === dbVersion) {
              dbVersion = data.version;
              return Promise.resolve({ count: 1 });
            }
            return Promise.resolve({ count: 0 });
          }),
        },
      } as unknown as Prisma.TransactionClient;

      const programId = "prog_monotonic";
      const intermediateVersions: number[] = [dbVersion];

      for (let i = 0; i < 5; i++) {
        const expected = dbVersion;
        const result = await updateLoyaltyProgramWithOCC({
          tx: mockTx,
          programId,
          expectedVersion: expected,
          data: { status: "active" },
        });
        expect(result.version).toBe(expected + 1);
        intermediateVersions.push(result.version);
      }

      expect(intermediateVersions).toEqual([10, 11, 12, 13, 14, 15]);
      expect(dbVersion).toBe(15);
    });

    it("rejects forward-drifted version (expectedVersion > currentVersion)", async () => {
      const mockTx = {
        weleticLoyaltyProgram: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      } as unknown as Prisma.TransactionClient;

      await expect(
        updateLoyaltyProgramWithOCC({
          tx: mockTx,
          programId: "prog_drift",
          expectedVersion: 100, // DB is at 1
          data: { name: "Forward Drift" },
        }),
      ).rejects.toThrow(OptimisticLockConflictError);
    });

    it("rejects backward-drifted stale version (expectedVersion < currentVersion)", async () => {
      const mockTx = {
        weleticLoyaltyProgram: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      } as unknown as Prisma.TransactionClient;

      await expect(
        updateLoyaltyProgramWithOCC({
          tx: mockTx,
          programId: "prog_stale_drift",
          expectedVersion: 1, // DB is already at 5
          data: { name: "Backward Drift" },
        }),
      ).rejects.toThrow(OptimisticLockConflictError);
    });

    it("assertLoyaltyProgramVersionMatches rejects when program state changed", async () => {
      const mockTx = {
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue({
            id: "prog_drift",
            version: 3,
            status: "active",
            killSwitchActive: false,
          }),
        },
      } as unknown as Prisma.TransactionClient;

      // Version mismatch
      await expect(
        assertLoyaltyProgramVersionMatches({
          tx: mockTx,
          programId: "prog_drift",
          expectedVersion: 2,
        }),
      ).rejects.toThrow(OptimisticLockConflictError);

      // Status disabled mismatch even if version matches
      mockTx.weleticLoyaltyProgram.findUnique = vi.fn().mockResolvedValue({
        id: "prog_drift",
        version: 2,
        status: "disabled",
        killSwitchActive: false,
      });

      await expect(
        assertLoyaltyProgramVersionMatches({
          tx: mockTx,
          programId: "prog_drift",
          expectedVersion: 2,
        }),
      ).rejects.toThrow(OptimisticLockConflictError);

      // Kill switch active mismatch even if version matches
      mockTx.weleticLoyaltyProgram.findUnique = vi.fn().mockResolvedValue({
        id: "prog_drift",
        version: 2,
        status: "active",
        killSwitchActive: true,
      });

      await expect(
        assertLoyaltyProgramVersionMatches({
          tx: mockTx,
          programId: "prog_drift",
          expectedVersion: 2,
        }),
      ).rejects.toThrow(OptimisticLockConflictError);
    });
  });

  describe("3. Lock-Free CSV Historical Import Inspections", () => {
    it("empirically verifies inspectHistoricalImportSourceInTransaction executes 0 FOR UPDATE queries", async () => {
      const executedQueries: string[] = [];
      const queryRawSpy = vi.fn().mockImplementation((query: any) => {
        const sql = String(query?.strings || query || "");
        executedQueries.push(sql);
        if (sql.includes("WeleticShopifyStore")) {
          return [{ id: "store_inspect_test", storeAccessState: "active" }];
        }
        if (sql.includes("WeleticLoyaltyProgram")) {
          return [
            {
              id: "prog_inspect_test",
              storeId: "store_inspect_test",
              status: "active",
              killSwitchActive: false,
              metadata: null,
              version: 2,
            },
          ];
        }
        return [];
      });

      const bytes = new TextEncoder().encode(
        JSON.stringify([
          {
            shopifyCustomerId: "gid://shopify/Customer/999",
            openingBalance: "500",
          },
        ]),
      );
      const source = {
        format: "json",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      const parsed = parseHistoricalImportSource({ bytes, source });
      const request = {
        operation: "inspect",
        expectedInstallationGeneration: "gen_xyz",
        source,
      };

      const mockTx = {
        $queryRaw: queryRawSpy,
        weleticLoyaltyProgram: {
          findFirst: vi.fn().mockResolvedValue({ id: "prog_inspect_test" }),
        },
        weleticLoyaltyTier: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        weleticShopper: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "shopper_999",
              storeId: "store_inspect_test",
              shopifyCustomerId: "999",
              loyaltyAccount: null,
            },
          ]),
        },
        weleticShopifyCustomerPrivacyTombstone: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        weleticLoyaltyImportSource: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      } as unknown as Prisma.TransactionClient;

      const result = await inspectHistoricalImportSourceInTransaction({
        tx: mockTx,
        storeId: "store_inspect_test",
        installationGeneration: "gen_xyz",
        request,
        bytes,
      });

      expect(result.valid).toBe(true);
      expect(result.rowCount).toBe(1);
      expect(result.totalOpeningBalance).toBe("500");

      // Verify that NO query contained "FOR UPDATE"
      const forUpdateQueries = executedQueries.filter((sql) =>
        sql.toUpperCase().includes("FOR UPDATE"),
      );
      expect(forUpdateQueries).toHaveLength(0);
    });

    it("verifies stageHistoricalImportInTransaction aborts with OptimisticLockConflictError if version drifts during inspection", async () => {
      const queryRawSpy = vi.fn().mockImplementation((query: any) => {
        const sql = String(query?.strings || query || "");
        if (sql.includes("WeleticShopifyStore")) {
          return [{ id: "store_stage_drift", storeAccessState: "active" }];
        }
        if (sql.includes("WeleticLoyaltyProgram")) {
          return [
            {
              id: "prog_stage_drift",
              storeId: "store_stage_drift",
              status: "active",
              killSwitchActive: false,
              metadata: null,
              version: 1, // Snapshot observes version 1
            },
          ];
        }
        return [];
      });

      const bytes = new TextEncoder().encode(
        JSON.stringify([
          {
            shopifyCustomerId: "gid://shopify/Customer/888",
            openingBalance: "200",
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
        expectedInstallationGeneration: "gen_drift",
        expectedRevision: historicalImportRevision({
          storeId: "store_stage_drift",
          programId: "prog_stage_drift",
          installationGeneration: "gen_drift",
          normalizedSha256: parsed.normalizedSha256,
          source: null,
        }),
        source,
      };

      const mockTx = {
        $queryRaw: queryRawSpy,
        weleticLoyaltyProgram: {
          // Meanwhile, DB version drifted to 2!
          findUnique: vi.fn().mockResolvedValue({
            id: "prog_stage_drift",
            version: 2,
            status: "active",
            killSwitchActive: false,
          }),
          findFirst: vi.fn().mockResolvedValue({ id: "prog_stage_drift" }),
        },
        weleticLoyaltyTier: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        weleticShopper: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "shopper_888",
              storeId: "store_stage_drift",
              shopifyCustomerId: "888",
              loyaltyAccount: null,
            },
          ]),
        },
        weleticShopifyCustomerPrivacyTombstone: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        weleticLoyaltyImportSource: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn(),
        },
        weleticLoyaltyImportRowSnapshot: {
          createMany: vi.fn(),
        },
      } as unknown as Prisma.TransactionClient;

      await expect(
        stageHistoricalImportInTransaction({
          tx: mockTx,
          storeId: "store_stage_drift",
          installationGeneration: "gen_drift",
          staffId: "staff_drift",
          request,
          bytes,
        }),
      ).rejects.toThrow(OptimisticLockConflictError);

      // Verify that no import source or rows were created
      expect(mockTx.weleticLoyaltyImportSource.create).not.toHaveBeenCalled();
      expect(mockTx.weleticLoyaltyImportRowSnapshot.createMany).not.toHaveBeenCalled();
    });
  });

  describe("4. Edge Cases, Aliases & Backward Compatibility", () => {
    it("updateLoyaltyProgramWithOcc alias matches updateLoyaltyProgramWithOCC behavior", () => {
      expect(updateLoyaltyProgramWithOcc).toBe(updateLoyaltyProgramWithOCC);
    });

    it("throws OptimisticLockConflictError when program ID does not exist in DB", async () => {
      const mockTx = {
        weleticLoyaltyProgram: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      } as unknown as Prisma.TransactionClient;

      await expect(
        updateLoyaltyProgramWithOCC({
          tx: mockTx,
          programId: "non_existent_program",
          expectedVersion: 1,
        }),
      ).rejects.toThrow(OptimisticLockConflictError);
    });

    it("verifies readLoyaltyProgramSnapshot handles NULL legacy version via COALESCE", async () => {
      const queryRawSpy = vi.fn().mockImplementation((query: any) => {
        const sql = String(query?.strings || query || "");
        if (sql.includes("WeleticShopifyStore")) {
          return [{ id: "store_null_ver", storeAccessState: "active" }];
        }
        if (sql.includes("WeleticLoyaltyProgram")) {
          return [
            {
              id: "prog_null_ver",
              storeId: "store_null_ver",
              status: "active",
              killSwitchActive: false,
              metadata: null,
              version: null, // simulates legacy pre-migration row
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
        storeId: "store_null_ver",
        mode: "active",
      });

      expect(snapshot.id).toBe("prog_null_ver");
      expect(snapshot.version).toBe(1); // Defaulted to 1
    });
  });
});
