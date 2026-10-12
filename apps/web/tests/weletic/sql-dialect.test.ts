import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  matchClockOnlyQuery,
  rewriteSql,
  rewriteUnsafe,
  stripForUpdate,
} from "@/lib/prisma/sql-dialect";

const NOW = new Date("2026-10-12T03:00:00.000Z");

describe("sql-dialect: FOR UPDATE", () => {
  it("strips FOR UPDATE variants", () => {
    expect(stripForUpdate("SELECT id FROM A WHERE id = ? FOR UPDATE")).toBe(
      "SELECT id FROM A WHERE id = ?",
    );
    expect(stripForUpdate("SELECT 1 LIMIT 1\n  for update skip locked")).toBe(
      "SELECT 1 LIMIT 1",
    );
    expect(stripForUpdate("SELECT 1 FOR UPDATE NOWAIT")).toBe("SELECT 1");
  });

  it("does not touch unrelated text", () => {
    expect(stripForUpdate("SELECT 'x' AS formupdate")).toBe(
      "SELECT 'x' AS formupdate",
    );
  });
});

describe("sql-dialect: tagged Prisma.Sql", () => {
  it("replaces CURRENT_TIMESTAMP(3) with a bound Date and keeps value order", () => {
    const id = "abc";
    const sql = Prisma.sql`SELECT id FROM T WHERE id = ${id} AND expiresAt > CURRENT_TIMESTAMP(3) AND x = ${5} FOR UPDATE`;
    const out = rewriteSql(sql, NOW);
    expect(out.values).toEqual(["abc", NOW, 5]);
    expect(out.strings.join("?")).toBe(
      "SELECT id FROM T WHERE id = ? AND expiresAt > ? AND x = ?",
    );
  });

  it("handles bare CURRENT_TIMESTAMP, NOW() and multiple occurrences", () => {
    const sql = Prisma.sql`UPDATE T SET a = CURRENT_TIMESTAMP, b = now(), c = ${1} WHERE d < CURRENT_TIMESTAMP(3)`;
    const out = rewriteSql(sql, NOW);
    expect(out.values).toEqual([NOW, NOW, 1, NOW]);
    expect(out.strings.length).toBe(out.values.length + 1);
  });

  it("does not rewrite inside string literals", () => {
    const sql = Prisma.sql`SELECT 'CURRENT_TIMESTAMP' AS lbl, ${1} AS n`;
    const out = rewriteSql(sql, NOW);
    expect(out.values).toEqual([1]);
    expect(out.strings.join("?")).toBe("SELECT 'CURRENT_TIMESTAMP' AS lbl, ? AS n");
  });

  it("leaves DDL untouched", () => {
    const sql = Prisma.sql`CREATE TABLE t (createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`;
    expect(rewriteSql(sql, NOW)).toBe(sql);
  });

  it("returns the same object when nothing needs rewriting", () => {
    const sql = Prisma.sql`SELECT ${1} AS a`;
    expect(rewriteSql(sql, NOW)).toBe(sql);
  });

  it("is stateless across consecutive calls (clock token at end of a fragment)", () => {
    // A clock token at the very end of a statement used to leave a stale
    // global-regex lastIndex that made the *next* query skip its rewrite.
    rewriteSql(Prisma.sql`SELECT 1 WHERE a > ${1} AND b > CURRENT_TIMESTAMP(3)`, NOW);
    const out = rewriteSql(
      Prisma.sql`UPDATE T SET e = CURRENT_TIMESTAMP(3) WHERE id = ${"x"}`,
      NOW,
    );
    expect(out.values).toEqual([NOW, "x"]);
  });

  it("composes with nested Prisma.sql fragments (forUpdateClause style)", () => {
    const lock = Prisma.sql`FOR UPDATE`;
    const sql = Prisma.sql`SELECT id FROM T WHERE id = ${"a"} ${lock}`;
    const out = rewriteSql(sql, NOW);
    expect(out.values).toEqual(["a"]);
    expect(out.strings.join("?").trim()).toBe("SELECT id FROM T WHERE id = ?");
  });
});

describe("sql-dialect: unsafe raw queries", () => {
  it("rewrites clock + FOR UPDATE and keeps positional params aligned", () => {
    const out = rewriteUnsafe(
      [
        "SELECT * FROM T WHERE a = ? AND exp > CURRENT_TIMESTAMP(3) AND b = ? FOR UPDATE",
        "A",
        "B",
      ],
      NOW,
    );
    expect(out).toEqual([
      "SELECT * FROM T WHERE a = ? AND exp > ? AND b = ?",
      "A",
      NOW,
      "B",
    ]);
  });

  it("ignores `?` and clock tokens inside literals", () => {
    const out = rewriteUnsafe(
      ["SELECT '?' AS q, 'NOW()' AS n, x FROM T WHERE y = ? AND z < NOW()", "Y"],
      NOW,
    );
    expect(out).toEqual([
      "SELECT '?' AS q, 'NOW()' AS n, x FROM T WHERE y = ? AND z < ?",
      "Y",
      NOW,
    ]);
  });

  it("is a no-op for DDL and plain queries", () => {
    const ddl = ["CREATE INDEX i ON t(a) WHERE b > CURRENT_TIMESTAMP"];
    expect(rewriteUnsafe(ddl, NOW)).toBe(ddl);
    const plain = ["SELECT 1 WHERE a = ?", 1];
    expect(rewriteUnsafe(plain, NOW)).toBe(plain);
  });
});

describe("sql-dialect: clock-only query", () => {
  it("detects SELECT CURRENT_TIMESTAMP(3) AS now", () => {
    expect(matchClockOnlyQuery("SELECT CURRENT_TIMESTAMP(3) AS now")).toBe("now");
    expect(matchClockOnlyQuery("  select now() as ts ; ")).toBe("ts");
    expect(matchClockOnlyQuery("SELECT CURRENT_TIMESTAMP(3) AS now, 1 AS x")).toBeNull();
    expect(matchClockOnlyQuery("SELECT id FROM T")).toBeNull();
  });
});

describe("sql-dialect: MySQL date and time constructs", () => {
  const NOW = new Date("2026-10-12T12:00:00.000Z");

  it("rewrites DATE_FORMAT(col, fmt) to strftime", () => {
    const raw = Prisma.sql`SELECT DATE_FORMAT(createdAt, '%Y-%m-%d') AS day FROM T`;
    const rewritten = rewriteSql(raw, NOW);
    expect(rewritten.strings.join("")).toContain("strftime('%Y-%m-%d'");
    expect(rewritten.strings.join("")).toContain("createdAt / 1000");
  });

  it("rewrites DATE_FORMAT(CONVERT_TZ(col, tz1, tz2), fmt) to strftime", () => {
    const raw = Prisma.sql`SELECT DATE_FORMAT(CONVERT_TZ(createdAt, 'UTC', '+00:00'), '%Y-%m') AS month FROM T`;
    const rewritten = rewriteSql(raw, NOW);
    expect(rewritten.strings.join("")).toContain("strftime('%Y-%m'");
  });

  it("rewrites cross-boundary DATE_FORMAT(CONVERT_TZ(...)) with template params", () => {
    const tz = "UTC";
    const fmt = "%Y-%m-%d";
    const raw = Prisma.sql`SELECT DATE_FORMAT(CONVERT_TZ(createdAt, "UTC", ${tz}), ${fmt}) AS start FROM T`;
    const rewritten = rewriteSql(raw, NOW);
    expect(rewritten.strings.join("?")).toContain("strftime(?");
    expect(rewritten.values).toEqual([tz, fmt]);
  });

  it("rewrites DATE_SUB with CURRENT_TIMESTAMP(3) to a bound Date", () => {
    const raw = Prisma.sql`UPDATE T SET lockedAt = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 6 MINUTE)`;
    const rewritten = rewriteSql(raw, NOW);
    expect(rewritten.values[0]).toEqual(new Date(NOW.getTime() - 360_000));
  });

  it("rewrites TIMESTAMPADD with CURRENT_TIMESTAMP(3) to a bound Date", () => {
    const raw = Prisma.sql`UPDATE T SET expiresAt = TIMESTAMPADD(SECOND, -1, CURRENT_TIMESTAMP(3))`;
    const rewritten = rewriteSql(raw, NOW);
    expect(rewritten.values[0]).toEqual(new Date(NOW.getTime() - 1_000));
  });

  it("rewrites cross-boundary TIMESTAMPADD with template params", () => {
    const deltaMs = 300_000;
    const raw = Prisma.sql`UPDATE T SET expiresAt = TIMESTAMPADD(MICROSECOND, ${deltaMs * 1000}, CURRENT_TIMESTAMP(3))`;
    const rewritten = rewriteSql(raw, NOW);
    expect(rewritten.strings.join("?")).toContain(`(${NOW.getTime()} + round(? / 1000))`);
    expect(rewritten.values).toEqual([deltaMs * 1000]);
  });
});

