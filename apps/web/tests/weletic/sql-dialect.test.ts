import {
  matchClockOnlyQuery,
  rewriteSql,
  rewriteUnsafe,
  stripForUpdate,
} from "@/lib/prisma/sql-dialect";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

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
    expect(out.strings.join("?")).toBe(
      "SELECT 'CURRENT_TIMESTAMP' AS lbl, ? AS n",
    );
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
    rewriteSql(
      Prisma.sql`SELECT 1 WHERE a > ${1} AND b > CURRENT_TIMESTAMP(3)`,
      NOW,
    );
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
      [
        "SELECT '?' AS q, 'NOW()' AS n, x FROM T WHERE y = ? AND z < NOW()",
        "Y",
      ],
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
    expect(matchClockOnlyQuery("SELECT CURRENT_TIMESTAMP(3) AS now")).toBe(
      "now",
    );
    expect(matchClockOnlyQuery("  select now() as ts ; ")).toBe("ts");
    expect(
      matchClockOnlyQuery("SELECT CURRENT_TIMESTAMP(3) AS now, 1 AS x"),
    ).toBeNull();
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
    expect(rewritten.strings.join("?")).toContain(
      `(${NOW.getTime()} + round(? / 1000))`,
    );
    expect(rewritten.values).toEqual([deltaMs * 1000]);
  });

  it("rewrites UTC_TIMESTAMP(3) similarly to CURRENT_TIMESTAMP", () => {
    const raw = Prisma.sql`SELECT id FROM T WHERE expiresAt > UTC_TIMESTAMP(3)`;
    const rewritten = rewriteSql(raw, NOW);
    expect(rewritten.values).toEqual([NOW]);
    expect(rewritten.strings.join("?")).toBe(
      "SELECT id FROM T WHERE expiresAt > ?",
    );
  });

  it("detects SELECT UTC_TIMESTAMP(3) AS now in matchClockOnlyQuery", () => {
    expect(matchClockOnlyQuery("SELECT UTC_TIMESTAMP(3) AS now")).toBe("now");
  });

  it("rewrites cross-boundary JSON_CONTAINS_PATH with template path param", () => {
    const path = "$.friendPrivacySnapshot";
    const raw = Prisma.sql`SELECT id FROM T WHERE COALESCE(JSON_CONTAINS_PATH(metadata, 'one', ${path}), 0) = 0`;
    const rewritten = rewriteSql(raw, NOW);
    expect(rewritten.strings.join("?")).toContain(
      "COALESCE((CASE WHEN json_type(metadata, ?",
    );
    expect(rewritten.strings.join("?")).toContain(
      ") IS NOT NULL THEN 1 ELSE 0 END), 0) = 0",
    );
    expect(rewritten.values).toEqual([path]);
  });

  it("rewrites cross-boundary JSON_UNQUOTE(JSON_EXTRACT(...)) with template path param", () => {
    const scanPath = "$.holdingPeriodDays";
    const raw = Prisma.sql`SELECT id FROM T WHERE JSON_UNQUOTE(JSON_EXTRACT(p.metadata, ${scanPath})) <= '2026-10-12'`;
    const rewritten = rewriteSql(raw, NOW);
    expect(rewritten.strings.join("?")).toContain(
      "json_extract(p.metadata, ?) <= '2026-10-12'",
    );
    expect(rewritten.values).toEqual([scanPath]);
  });

  it("rewrites static JSON_CONTAINS_PATH and JSON_UNQUOTE", () => {
    const raw = Prisma.sql`SELECT id FROM T WHERE JSON_CONTAINS_PATH(metadata, 'one', '$.flag') = 1 AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.status')) = 'active'`;
    const rewritten = rewriteSql(raw, NOW);
    expect(rewritten.strings.join("")).toContain(
      "(CASE WHEN json_type(metadata, '$.flag') IS NOT NULL THEN 1 ELSE 0 END) = 1",
    );
    expect(rewritten.strings.join("")).toContain(
      "json_extract(metadata, '$.status') = 'active'",
    );
  });

  it("normalizes JSON_TYPE comparisons for SQLite", () => {
    const raw = Prisma.sql`SELECT id FROM T WHERE JSON_TYPE(metadata) = 'STRING' AND JSON_TYPE(JSON_EXTRACT(metadata, '$.num')) = 'INTEGER' AND JSON_TYPE(metadata) <> 'OBJECT'`;
    const rewritten = rewriteSql(raw, NOW);
    const sql = rewritten.strings.join("");
    expect(sql).toContain("json_type(metadata) IN ('text', 'STRING')");
    expect(sql).toContain(
      "json_type(metadata, '$.num') IN ('integer', 'INTEGER')",
    );
    expect(sql).toContain("json_type(metadata) NOT IN ('object', 'OBJECT')");
  });

  it("rewrites LEAST to CASE WHEN expression", () => {
    const raw = Prisma.sql`SELECT LEAST(50, SUM(score)) AS score, LEAST(15, count * 2) AS matchScore FROM T`;
    const rewritten = rewriteSql(raw, NOW);
    const sql = rewritten.strings.join("");
    expect(sql).toContain(
      "(CASE WHEN (SUM(score)) < 50 THEN (SUM(score)) ELSE 50 END) AS score",
    );
    expect(sql).toContain(
      "(CASE WHEN (count * 2) < 15 THEN (count * 2) ELSE 15 END) AS matchScore",
    );
  });

  it("strips BINARY and maps CAST(... AS BINARY) to CAST(... AS BLOB)", () => {
    const raw = Prisma.sql`SELECT BINARY id, CAST(sku AS BINARY) FROM T WHERE BINARY col = BINARY 'val' ORDER BY BINARY id`;
    const rewritten = rewriteSql(raw, NOW);
    const sql = rewritten.strings.join("");
    expect(sql).not.toMatch(/\bBINARY\b/);
    expect(sql).toContain("CAST(sku AS BLOB)");
    expect(sql).toContain(
      "SELECT id, CAST(sku AS BLOB) FROM T WHERE col = 'val' ORDER BY id",
    );
  });

  it("strips FORCE INDEX and maps STRAIGHT_JOIN to JOIN", () => {
    const raw = Prisma.sql`SELECT a.id FROM A a FORCE INDEX (PRIMARY) STRAIGHT_JOIN B b FORCE INDEX (idx_b) ON a.id = b.aId`;
    const rewritten = rewriteSql(raw, NOW);
    const sql = rewritten.strings.join("");
    expect(sql).not.toContain("FORCE INDEX");
    expect(sql).not.toContain("STRAIGHT_JOIN");
    expect(sql).toContain("JOIN B b");
  });

  it("maps CHAR_LENGTH to length and JSON_ARRAYAGG to json_group_array", () => {
    const raw = Prisma.sql`SELECT JSON_ARRAYAGG(val), CHAR_LENGTH(name), JSON_LENGTH(items) FROM T`;
    const rewritten = rewriteSql(raw, NOW);
    const sql = rewritten.strings.join("");
    expect(sql).toContain("json_group_array(val)");
    expect(sql).toContain("length(name)");
    expect(sql).toContain("json_array_length(items)");
  });

  it("maps ISO-8601 NOT REGEXP to length and LIKE checks", () => {
    const raw = Prisma.sql`SELECT id FROM T WHERE COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.retainUntil')), '') NOT REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'`;
    const rewritten = rewriteSql(raw, NOW);
    const sql = rewritten.strings.join("");
    expect(sql).toContain(
      "length(COALESCE(json_extract(metadata, '$.retainUntil'), '')) <> 24",
    );
    expect(sql).toContain("NOT LIKE '____-__-__T__:__:__.___Z'");
  });

  it("maps STR_TO_DATE with month concatenation to ISO timestamp concatenation", () => {
    const raw = Prisma.sql`SELECT STR_TO_DATE(CONCAT(active.month, '-01'), '%Y-%m-%d') AS date FROM T`;
    const rewritten = rewriteSql(raw, NOW);
    const sql = rewritten.strings.join("");
    expect(sql).toContain("(active.month || '-01T00:00:00.000Z')");
  });

  it("handles standalone NOW() and NOW(3) without other MySQL constructs", () => {
    const q1 = rewriteSql(Prisma.sql`SELECT NOW()`, NOW);
    expect(q1.values).toEqual([NOW]);
    expect(q1.strings.join("?")).toBe("SELECT ?");

    const q2 = rewriteSql(Prisma.sql`SELECT NOW(3)`, NOW);
    expect(q2.values).toEqual([NOW]);
    expect(q2.strings.join("?")).toBe("SELECT ?");
  });

  it("detects SELECT NOW(3) AS now in matchClockOnlyQuery", () => {
    expect(matchClockOnlyQuery("SELECT NOW(3) AS now")).toBe("now");
    expect(matchClockOnlyQuery("SELECT NOW() AS now")).toBe("now");
  });

  it("supports multi-argument and nested LEAST expressions", () => {
    const multi = Prisma.sql`SELECT LEAST(1, 2, 3) AS m`;
    const resMulti = rewriteSql(multi, NOW);
    expect(resMulti.strings.join("")).toContain(
      "(CASE WHEN ((CASE WHEN (3) < 2 THEN (3) ELSE 2 END)) < 1 THEN ((CASE WHEN (3) < 2 THEN (3) ELSE 2 END)) ELSE 1 END) AS m",
    );

    const nested = Prisma.sql`SELECT LEAST(10, LEAST(score, 5)) AS s`;
    const resNested = rewriteSql(nested, NOW);
    expect(resNested.strings.join("")).not.toContain("LEAST");
    expect(resNested.strings.join("")).toContain(
      "(CASE WHEN ((CASE WHEN (score) < 5 THEN (score) ELSE 5 END)) < 10 THEN ((CASE WHEN (score) < 5 THEN (score) ELSE 5 END)) ELSE 10 END) AS s",
    );
  });

  it("normalizes COALESCE(JSON_TYPE(...), '') comparisons", () => {
    const raw = Prisma.sql`SELECT id FROM WeleticLoyaltyEarnGrant WHERE COALESCE(JSON_TYPE(JSON_EXTRACT(calculationSnapshot, '$.holdingPeriodDays')), '') <> 'INTEGER'`;
    const rewritten = rewriteSql(raw, NOW);
    expect(rewritten.strings.join("")).toContain(
      "COALESCE(json_type(calculationSnapshot, '$.holdingPeriodDays'), '') NOT IN ('integer', 'INTEGER')",
    );
  });

  it("handles plural interval units in DATE_SUB and NOW(3)", () => {
    const raw = Prisma.sql`SELECT id FROM T WHERE lockedAt > DATE_SUB(NOW(3), INTERVAL 5 MINUTES)`;
    const rewritten = rewriteSql(raw, NOW);
    expect(rewritten.values).toEqual([new Date(NOW.getTime() - 5 * 60_000)]);
  });
});
