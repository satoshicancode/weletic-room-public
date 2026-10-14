import { createPrismaClient } from "@/lib/prisma";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
    const [clock] = await prisma.$queryRaw<
      Array<{ now: Date }>
    >`SELECT CURRENT_TIMESTAMP(3) AS now`;
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
    const expTime =
      row.expiresAt instanceof Date
        ? row.expiresAt.getTime()
        : Number(row.expiresAt);
    expect(expTime).toBeLessThan(Date.now() - 300_000);
  });

  it("rewrites TIMESTAMPADD with CURRENT_TIMESTAMP(3)", async () => {
    await prisma.$executeRaw`
      UPDATE lease SET expiresAt = TIMESTAMPADD(SECOND, -1, CURRENT_TIMESTAMP(3)) WHERE id = 'dead'`;
    const [row] = await prisma.$queryRaw<Array<{ expiresAt: Date | number }>>`
      SELECT expiresAt FROM lease WHERE id = 'dead'`;
    const expTime =
      row.expiresAt instanceof Date
        ? row.expiresAt.getTime()
        : Number(row.expiresAt);
    expect(expTime).toBeLessThan(Date.now());
  });

  it("executes UTC_TIMESTAMP(3) query and returns Date", async () => {
    const [clock] = await prisma.$queryRaw<
      Array<{ now: Date }>
    >`SELECT UTC_TIMESTAMP(3) AS now`;
    expect(clock.now).toBeInstanceOf(Date);
  });

  it("executes JSON_CONTAINS_PATH and JSON_UNQUOTE against real SQLite engine", async () => {
    await prisma.$executeRawUnsafe(
      "CREATE TABLE doc (id TEXT PRIMARY KEY, metadata TEXT NOT NULL)",
    );
    await prisma.$executeRaw`INSERT INTO doc (id, metadata) VALUES ('d1', '{"status":"active","count":42}')`;

    const path = "$.status";
    const [row] = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, JSON_UNQUOTE(JSON_EXTRACT(metadata, ${path})) AS status
      FROM doc
      WHERE COALESCE(JSON_CONTAINS_PATH(metadata, 'one', ${path}), 0) = 1
        AND JSON_TYPE(JSON_EXTRACT(metadata, '$.status')) = 'STRING'
        AND JSON_TYPE(JSON_EXTRACT(metadata, '$.count')) = 'INTEGER'
        AND JSON_TYPE(metadata) <> 'OBJECT'`;
    // Note: In SQLite, json_type(metadata) is 'object', so JSON_TYPE(metadata) <> 'OBJECT' evaluates to false
    // Let's verify that the normalization (NOT IN ('object', 'OBJECT')) correctly treats 'object' as object:
    expect(row).toBeUndefined();

    // Now query where metadata IS object:
    const [match] = await prisma.$queryRaw<
      Array<{ id: string; status: string }>
    >`
      SELECT id, JSON_UNQUOTE(JSON_EXTRACT(metadata, ${path})) AS status
      FROM doc
      WHERE COALESCE(JSON_CONTAINS_PATH(metadata, 'one', ${path}), 0) = 1
        AND JSON_TYPE(JSON_EXTRACT(metadata, '$.status')) = 'STRING'
        AND JSON_TYPE(JSON_EXTRACT(metadata, '$.count')) = 'INTEGER'
        AND JSON_TYPE(metadata) = 'OBJECT'`;
    expect(match?.id).toBe("d1");
    expect(match?.status).toBe("active");
  });

  it("executes LEAST, CHAR_LENGTH, and BINARY against real SQLite engine", async () => {
    const [res] = await prisma.$queryRaw<
      Array<{ lowest: bigint | number; len: bigint | number }>
    >`
      SELECT LEAST(50, 100) AS lowest, CHAR_LENGTH('weletic') AS len
      FROM doc WHERE BINARY id = BINARY 'd1' ORDER BY BINARY id`;
    expect(Number(res.lowest)).toBe(50);
    expect(Number(res.len)).toBe(7);
  });

  it("executes standalone NOW() and NOW(3) against real SQLite engine", async () => {
    const [row] = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM doc WHERE NOW() IS NOT NULL`;
    expect(row?.id).toBe("d1");

    const [row3] = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM doc WHERE NOW(3) IS NOT NULL`;
    expect(row3?.id).toBe("d1");
  });

  it("executes multi-arg and nested LEAST against real SQLite engine", async () => {
    const [res] = await prisma.$queryRaw<
      Array<{ val1: number | bigint; val2: number | bigint }>
    >`
      SELECT LEAST(10, 5, 20) AS val1, LEAST(100, LEAST(50, 25)) AS val2 FROM doc WHERE id = 'd1'`;
    expect(Number(res.val1)).toBe(5);
    expect(Number(res.val2)).toBe(25);
  });

  it("executes COALESCE(JSON_TYPE(...), '') against real SQLite engine correctly distinguishing integers", async () => {
    await prisma.$executeRaw`INSERT INTO doc (id, metadata) VALUES ('d2', '{"status":"pending","count":"not_int"}')`;

    // d1 has count=42 (integer), d2 has count="not_int" (string)
    // Querying for count <> INTEGER should only match d2:
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM doc
      WHERE COALESCE(JSON_TYPE(JSON_EXTRACT(metadata, '$.count')), '') <> 'INTEGER'
      ORDER BY id`;
    expect(rows.map((r) => r.id)).toEqual(["d2"]);
  });

  it("executes JSON_LENGTH against real SQLite engine", async () => {
    await prisma.$executeRaw`INSERT INTO doc (id, metadata) VALUES ('d3', '{"items":[10,20,30]}')`;
    const [row] = await prisma.$queryRaw<
      Array<{ id: string; len: bigint | number }>
    >`
      SELECT id, JSON_LENGTH(JSON_EXTRACT(metadata, '$.items')) AS len
      FROM doc WHERE id = 'd3'`;
    expect(row?.id).toBe("d3");
    expect(Number(row?.len)).toBe(3);
  });
});
