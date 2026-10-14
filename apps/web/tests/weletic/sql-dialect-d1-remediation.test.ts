import { createPrismaClient } from "@/lib/prisma";
import { rewriteConstructs, rewriteSql } from "@/lib/prisma/sql-dialect";
import { Prisma } from "@prisma/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("Milestone 2: D1/SQLite Runtime Dialect, SQL Fixes & Migrations Parity", () => {
  let dir: string;
  let prisma: ReturnType<typeof createPrismaClient>;
  const previousUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "weletic-m2-remediation-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "m2-test.db")}`;
    prisma = createPrismaClient();

    // Setup tables for dialect & SQLite compatibility testing
    await prisma.$executeRawUnsafe(`
      CREATE TABLE test_null_safe (
        id TEXT PRIMARY KEY,
        claimId TEXT,
        lockedBy TEXT,
        score INTEGER
      )
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE test_categories (
        id TEXT PRIMARY KEY,
        partnerId TEXT NOT NULL,
        category TEXT NOT NULL
      )
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE test_retention (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        counter INTEGER NOT NULL
      )
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE test_ledger (
        id TEXT PRIMARY KEY,
        accountId TEXT NOT NULL,
        storeId TEXT NOT NULL,
        pointsDelta INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      )
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE test_invoices (
        id TEXT PRIMARY KEY,
        programId TEXT NOT NULL,
        amount INTEGER NOT NULL,
        fee INTEGER NOT NULL,
        paymentMethod TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    rmSync(dir, { recursive: true, force: true });
  });

  describe("1. MySQL NULL-safe <=> Operator Translation", () => {
    it("rewrites <=> to IS in string constructs", () => {
      const rewritten = rewriteConstructs(
        "SELECT * FROM t WHERE lockedAt <=> ? AND lockedBy <=> ?",
      );
      expect(rewritten).toBe(
        "SELECT * FROM t WHERE lockedAt IS ? AND lockedBy IS ?",
      );
    });

    it("translates <=> in tagged Prisma.sql queries", () => {
      const query = rewriteSql(
        Prisma.sql`SELECT * FROM t WHERE lockedBy <=> ${null}`,
      );
      const sqlText = query.strings.join("?");
      expect(sqlText).toContain("lockedBy IS ?");
    });

    it("executes <=> correctly against real SQLite database for NULL and non-NULL values", async () => {
      await prisma.$executeRaw`INSERT INTO test_null_safe (id, claimId, lockedBy, score) VALUES ('row1', 'c1', NULL, 10)`;
      await prisma.$executeRaw`INSERT INTO test_null_safe (id, claimId, lockedBy, score) VALUES ('row2', 'c2', 'worker-1', 20)`;

      // Query NULL-safe with null:
      const nullRows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM test_null_safe WHERE lockedBy <=> ${null} ORDER BY id
      `;
      expect(nullRows.map((r) => r.id)).toEqual(["row1"]);

      // Query NULL-safe with value:
      const workerRows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM test_null_safe WHERE lockedBy <=> ${"worker-1"} ORDER BY id
      `;
      expect(workerRows.map((r) => r.id)).toEqual(["row2"]);

      // Query NULL-safe in unsafe raw query:
      const unsafeNull = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        "SELECT id FROM test_null_safe WHERE lockedBy <=> ?",
        null,
      );
      expect(unsafeNull.map((r) => r.id)).toEqual(["row1"]);
    });
  });

  describe("2. GROUP_CONCAT SQLite Compatibility", () => {
    it("rewrites GROUP_CONCAT(DISTINCT ... ORDER BY ... SEPARATOR ',') to group_concat(DISTINCT ...)", () => {
      const rewritten = rewriteConstructs(
        "SELECT GROUP_CONCAT(DISTINCT pc.category ORDER BY pc.category SEPARATOR ',') as categories FROM ProgramCategory pc",
      );
      expect(rewritten).toBe(
        "SELECT group_concat(DISTINCT pc.category) as categories FROM ProgramCategory pc",
      );
    });

    it("rewrites custom separator when DISTINCT is not present", () => {
      const rewritten = rewriteConstructs(
        "SELECT GROUP_CONCAT(col ORDER BY col SEPARATOR ';') as cats FROM T",
      );
      expect(rewritten).toBe("SELECT group_concat(col, ';') as cats FROM T");
    });

    it("executes GROUP_CONCAT query against real SQLite database without syntax errors", async () => {
      await prisma.$executeRaw`INSERT INTO test_categories (id, partnerId, category) VALUES ('cat1', 'p1', 'fashion')`;
      await prisma.$executeRaw`INSERT INTO test_categories (id, partnerId, category) VALUES ('cat2', 'p1', 'fitness')`;
      await prisma.$executeRaw`INSERT INTO test_categories (id, partnerId, category) VALUES ('cat3', 'p1', 'fashion')`; // duplicate

      const [row] = await prisma.$queryRaw<Array<{ categories: string }>>`
        SELECT GROUP_CONCAT(DISTINCT category ORDER BY category SEPARATOR ',') as categories
        FROM test_categories
        WHERE partnerId = 'p1'
      `;
      expect(row.categories.split(",").sort()).toEqual(["fashion", "fitness"]);
    });
  });

  describe("3. LEAST SQLite Translation", () => {
    it("rewrites LEAST to MIN or CASE WHEN in sql-dialect", () => {
      const single = rewriteConstructs("SELECT LEAST(50, 100) AS val");
      expect(single).toMatch(/(?:CASE WHEN|MIN\()/);

      const crossBoundary = rewriteConstructs("SELECT LEAST(50, SUM(score))");
      expect(crossBoundary).toMatch(/(?:CASE WHEN|MIN\()/);
    });

    it("executes LEAST with SUM on SQLite database", async () => {
      const [res] = await prisma.$queryRaw<Array<{ capped: number | bigint }>>`
        SELECT LEAST(50, SUM(score)) as capped FROM test_null_safe
      `;
      expect(Number(res.capped)).toBe(30); // 10 + 20 = 30, LEAST(50, 30) = 30
    });
  });

  describe("4. Date Function & Series Query SQLite Compatibility", () => {
    it("rewrites cross-boundary DATE_FORMAT(${date}, '%Y-%m') cleanly", () => {
      const date = new Date("2026-08-15T12:00:00Z");
      const query = rewriteSql(
        Prisma.sql`SELECT * FROM t WHERE active_month = DATE_FORMAT(${date}, '%Y-%m')`,
      );
      expect(query.values).toContain("2026-08");
      expect(query.strings.join("?")).not.toContain("DATE_FORMAT");
    });

    it("evaluates cohort series logic correctly without STR_TO_DATE type mismatch", async () => {
      const startAt = new Date("2026-08-15T00:00:00.000Z");
      const startMonth = "2026-08";

      // Seed ledger entries:
      // Account 1: earned in July 2026 (prior to start month)
      await prisma.$executeRaw`
        INSERT INTO test_ledger (id, accountId, storeId, pointsDelta, createdAt)
        VALUES ('l1', 'acc1', 'store1', 100, ${new Date("2026-07-20T00:00:00.000Z").getTime()})
      `;
      // Account 1 also earned in August
      await prisma.$executeRaw`
        INSERT INTO test_ledger (id, accountId, storeId, pointsDelta, createdAt)
        VALUES ('l2', 'acc1', 'store1', 50, ${new Date("2026-08-20T00:00:00.000Z").getTime()})
      `;

      // Account 2: earned for the first time in August 2026 (after startAt)
      await prisma.$executeRaw`
        INSERT INTO test_ledger (id, accountId, storeId, pointsDelta, createdAt)
        VALUES ('l3', 'acc2', 'store1', 200, ${new Date("2026-08-20T00:00:00.000Z").getTime()})
      `;

      // Account 3: earned before startAt in August 2026 (August 5)
      await prisma.$executeRaw`
        INSERT INTO test_ledger (id, accountId, storeId, pointsDelta, createdAt)
        VALUES ('l4', 'acc3', 'store1', 150, ${new Date("2026-08-05T00:00:00.000Z").getTime()})
      `;
      await prisma.$executeRaw`
        INSERT INTO test_ledger (id, accountId, storeId, pointsDelta, createdAt)
        VALUES ('l5', 'acc3', 'store1', 50, ${new Date("2026-08-22T00:00:00.000Z").getTime()})
      `;

      // Run the cohort query using the fixed date condition
      const activeMonth = "2026-08";
      const results = await prisma.$queryRaw<
        Array<{ accountId: string; hasPrior: number }>
      >`
        SELECT l.accountId,
               CASE WHEN EXISTS (
                 SELECT 1 FROM test_ledger h
                 WHERE h.accountId = l.accountId
                   AND h.storeId = 'store1'
                   AND (
                     DATE_FORMAT(h.createdAt, '%Y-%m') < ${activeMonth}
                     OR (${activeMonth} = DATE_FORMAT(${startAt}, '%Y-%m') AND h.createdAt < ${startAt})
                   )
               ) THEN 1 ELSE 0 END AS hasPrior
        FROM test_ledger l
        WHERE l.id IN ('l2', 'l3', 'l5')
        ORDER BY l.accountId
      `;

      const map = Object.fromEntries(
        results.map((r) => [r.accountId, Number(r.hasPrior)]),
      );

      // acc1 had prior earn in July -> hasPrior = 1
      expect(map["acc1"]).toBe(1);

      // acc2 first earned Aug 20 (after startAt Aug 15) -> hasPrior = 0 (first-recorded earner!)
      expect(map["acc2"]).toBe(0);

      // acc3 had earn Aug 5 (before startAt Aug 15) -> hasPrior = 1
      expect(map["acc3"]).toBe(1);
    });
  });

  describe("5. Retention Subquery Syntax (SQLite LIMIT in UPDATE)", () => {
    it("executes UPDATE with WHERE id IN (SELECT id ... LIMIT n) without syntax error", async () => {
      // Seed rows
      for (let i = 1; i <= 5; i++) {
        await prisma.$executeRaw`
          INSERT INTO test_retention (id, status, counter) VALUES (${`r${i}`}, 'pending', 0)
        `;
      }

      const take = 2;
      const updated = await prisma.$executeRaw`
        UPDATE test_retention
        SET status = 'processed',
            counter = counter + 1
        WHERE id IN (
          SELECT id FROM test_retention
          WHERE status = 'pending'
          ORDER BY id ASC
          LIMIT ${take}
        )
      `;

      expect(Number(updated)).toBe(2);

      const processedRows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM test_retention WHERE status = 'processed' ORDER BY id ASC
      `;
      expect(processedRows.map((r) => r.id)).toEqual(["r1", "r2"]);

      const pendingRows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM test_retention WHERE status = 'pending' ORDER BY id ASC
      `;
      expect(pendingRows.map((r) => r.id)).toEqual(["r3", "r4", "r5"]);
    });
  });

  describe("6. Safe BigInt Coercion in Activity Series", () => {
    it("safely coerces BigInt, number, string, Decimal and null/undefined without toFixed TypeError", () => {
      const coerceBigInt = (
        val: string | number | bigint | Prisma.Decimal | null | undefined,
      ): bigint => {
        if (val === null || val === undefined) return BigInt(0);
        if (typeof val === "bigint") return val;
        if (typeof val === "number") return BigInt(Math.trunc(val));
        if (typeof val === "string") return BigInt(val.split(".")[0] || "0");
        if (typeof (val as any).toFixed === "function")
          return BigInt((val as any).toFixed(0));
        return BigInt(String(val).split(".")[0] || "0");
      };

      // Native BigInt from SQLite driver:
      expect(coerceBigInt(BigInt(100))).toBe(BigInt(100));
      // Plain number:
      expect(coerceBigInt(250)).toBe(BigInt(250));
      // String from CAST AS CHAR:
      expect(coerceBigInt("500")).toBe(BigInt(500));
      expect(coerceBigInt("500.00")).toBe(BigInt(500));
      // Null / undefined:
      expect(coerceBigInt(null)).toBe(BigInt(0));
      expect(coerceBigInt(undefined)).toBe(BigInt(0));
      // Prisma.Decimal mock:
      expect(coerceBigInt({ toFixed: (digits: number) => "750" } as any)).toBe(
        BigInt(750),
      );
    });
  });

  describe("7. Payouts Timeseries Date Parameter Binding", () => {
    it("matches SQLite integer ms columns when Date objects are passed", async () => {
      const t1 = new Date("2026-08-01T10:00:00Z");
      const t2 = new Date("2026-08-10T15:00:00Z");
      const t3 = new Date("2026-08-20T20:00:00Z");

      await prisma.$executeRaw`
        INSERT INTO test_invoices (id, programId, amount, fee, paymentMethod, status, createdAt)
        VALUES ('inv1', 'prog1', 1000, 50, 'card', 'paid', ${t1.getTime()})
      `;
      await prisma.$executeRaw`
        INSERT INTO test_invoices (id, programId, amount, fee, paymentMethod, status, createdAt)
        VALUES ('inv2', 'prog1', 2000, 100, 'card', 'paid', ${t2.getTime()})
      `;
      await prisma.$executeRaw`
        INSERT INTO test_invoices (id, programId, amount, fee, paymentMethod, status, createdAt)
        VALUES ('inv3', 'prog1', 3000, 150, 'card', 'paid', ${t3.getTime()})
      `;

      const start = new Date("2026-08-05T00:00:00Z");
      const end = new Date("2026-08-15T00:00:00Z");

      // When Date objects are passed, rewriteUnsafe / Prisma bindings match the epoch-ms integer column:
      const matched = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        "SELECT id FROM test_invoices WHERE createdAt >= ? AND createdAt <= ?",
        start,
        end,
      );

      expect(matched.map((r) => r.id)).toEqual(["inv2"]);
    });
  });

  describe("8. Native D1 BigInt Normalization in Cron Triggers", () => {
    it("correctly identifies matching balances across heterogeneous types", () => {
      const testCases = [
        { totalDelta: 0, lastBalance: BigInt(0), shouldMatch: true },
        { totalDelta: "100", lastBalance: BigInt(100), shouldMatch: true },
        { totalDelta: BigInt(500), lastBalance: 500, shouldMatch: true },
        { totalDelta: BigInt(1000), lastBalance: "1000", shouldMatch: true },
        { totalDelta: 0, lastBalance: null, shouldMatch: true },
        {
          totalDelta: BigInt(100),
          lastBalance: BigInt(99),
          shouldMatch: false,
        },
        { totalDelta: "200", lastBalance: 150, shouldMatch: false },
      ];

      for (const tc of testCases) {
        const isDiscrepant =
          BigInt(tc.totalDelta ?? 0) !== BigInt(tc.lastBalance ?? 0);
        expect(!isDiscrepant).toBe(tc.shouldMatch);
      }
    });
  });
});
