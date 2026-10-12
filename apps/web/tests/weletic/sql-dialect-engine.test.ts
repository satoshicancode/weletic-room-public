import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/lib/prisma";

/**
 * Runs MySQL-flavoured raw SQL through the real native SQLite engine via the
 * dialect extension installed by createPrismaClient().
 */
describe("createPrismaClient SQL dialect extension (real SQLite engine)", () => {
  let dir: string;
  let prisma: ReturnType<typeof createPrismaClient>;
  const previousUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "weletic-dialect-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "t.db")}`;
    prisma = createPrismaClient();
    await prisma.$executeRawUnsafe(
      "CREATE TABLE lease (id TEXT PRIMARY KEY, expiresAt DATETIME NOT NULL)",
    );
    await prisma.$executeRaw`INSERT INTO lease (id, expiresAt) VALUES ('live', ${new Date(Date.now() + 3_600_000)})`;
    await prisma.$executeRaw`INSERT INTO lease (id, expiresAt) VALUES ('dead', ${new Date(Date.now() - 3_600_000)})`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts FOR UPDATE and CURRENT_TIMESTAMP(3) in tagged raw queries", async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM lease WHERE expiresAt > CURRENT_TIMESTAMP(3) ORDER BY id FOR UPDATE`;
    expect(rows.map((r) => r.id)).toEqual(["live"]);

    const expired = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM lease WHERE expiresAt <= CURRENT_TIMESTAMP(3) ORDER BY id`;
    expect(expired.map((r) => r.id)).toEqual(["dead"]);
  });

  it("accepts the same dialect in unsafe raw queries", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      "SELECT id FROM lease WHERE id != ? AND expiresAt > NOW() FOR UPDATE",
      "none",
    );
    expect(rows.map((r) => r.id)).toEqual(["live"]);
  });

  it("answers `SELECT CURRENT_TIMESTAMP(3) AS now` with a Date", async () => {
    const before = Date.now();
    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP(3) AS now`;
    expect(clock.now).toBeInstanceOf(Date);
    expect(clock.now.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(clock.now.getTime()).toBeLessThanOrEqual(Date.now() + 5);
  });

  it("applies inside interactive transactions", async () => {
    const ids = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM lease WHERE id = ${"live"} AND expiresAt > CURRENT_TIMESTAMP(3) FOR UPDATE`;
      return rows.map((r) => r.id);
    });
    expect(ids).toEqual(["live"]);
  });

  it("executeRaw can write CURRENT_TIMESTAMP-derived values", async () => {
    await prisma.$executeRaw`UPDATE lease SET expiresAt = CURRENT_TIMESTAMP(3) WHERE id = ${"dead"}`;
    const [row] = await prisma.$queryRaw<Array<{ id: string; t: string }>>`
      SELECT id, typeof(expiresAt) AS t FROM lease WHERE id = ${"dead"}`;
    expect(row.t).toBe("integer");
  });

  it("rewrites DATE_FORMAT on DateTime columns stored as integer milliseconds", async () => {
    const [row] = await prisma.$queryRaw<Array<{ d: string }>>`
      SELECT DATE_FORMAT(expiresAt, '%Y-%m') AS d FROM lease WHERE id = 'live'`;
    expect(row.d).toMatch(/^\d{4}-\d{2}$/);
  });

  it("rewrites DATE_SUB with CURRENT_TIMESTAMP(3)", async () => {
    await prisma.$executeRaw`
      UPDATE lease SET expiresAt = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 6 MINUTE) WHERE id = 'dead'`;
    const [row] = await prisma.$queryRaw<Array<{ expiresAt: Date | number }>>`
      SELECT expiresAt FROM lease WHERE id = 'dead'`;
    const expTime = row.expiresAt instanceof Date ? row.expiresAt.getTime() : Number(row.expiresAt);
    expect(expTime).toBeLessThan(Date.now() - 300_000);
  });

  it("rewrites TIMESTAMPADD with CURRENT_TIMESTAMP(3)", async () => {
    await prisma.$executeRaw`
      UPDATE lease SET expiresAt = TIMESTAMPADD(SECOND, -1, CURRENT_TIMESTAMP(3)) WHERE id = 'dead'`;
    const [row] = await prisma.$queryRaw<Array<{ expiresAt: Date | number }>>`
      SELECT expiresAt FROM lease WHERE id = 'dead'`;
    const expTime = row.expiresAt instanceof Date ? row.expiresAt.getTime() : Number(row.expiresAt);
    expect(expTime).toBeLessThan(Date.now());
  });
});
