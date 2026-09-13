import { describe, expect, it } from "vitest";
import {
  captureImportLookup,
  importLookupReplayValues,
  readImportPlanColumn,
  summarizeImportPlan,
  summarizeImportPlanError,
} from "./helpers/import-query-plan";

const query =
  "SELECT `id` FROM `fixture`.`WeleticPointsLedgerEntry` WHERE `idempotencyKey` = ? OR (`referenceType` = ? AND `referenceId` = ?) OR `metadata` = ? LIMIT ?";

describe("test-only import query plan boundary", () => {
  const jsonLookup =
    "SELECT `id` FROM `ledger` WHERE `id` = ? OR (JSON_CONTAINS(JSON_EXTRACT(`metadata`, ?), ?) AND JSON_CONTAINS(?, JSON_EXTRACT(`metadata`, ?))) OR (JSON_CONTAINS(JSON_EXTRACT(`metadata`, ?), ?) AND JSON_CONTAINS(?, JSON_EXTRACT(`metadata`, ?))) LIMIT ?";
  const loggedValues = [
    "id",
    "$.sourceId",
    "source",
    "source",
    "$.sourceId",
    "$.snapshotId",
    "row",
    "row",
    "$.snapshotId",
    1,
  ];
  it("restores only direct JSON scalar arguments and preserves the input", () => {
    expect(importLookupReplayValues(jsonLookup, loggedValues)).toEqual([
      "id",
      "$.sourceId",
      '"source"',
      '"source"',
      "$.sourceId",
      "$.snapshotId",
      '"row"',
      '"row"',
      "$.snapshotId",
      1,
    ]);
    expect(loggedValues[2]).toBe("source");
  });
  it("encodes string identities even when they resemble JSON primitives", () => {
    const values = [...loggedValues];
    values[2] = "null";
    values[3] = "123";
    expect(importLookupReplayValues(jsonLookup, values).slice(2, 4)).toEqual([
      '"null"',
      '"123"',
    ]);
  });
  it.each([
    "SELECT ?",
    jsonLookup + ")",
    jsonLookup + " 'literal'",
    jsonLookup.replace("`id`", "`?`"),
  ])("rejects unsupported replay shapes", (sql) => {
    expect(() => importLookupReplayValues(sql, loggedValues)).toThrow(
      "Import lookup parameter shape unavailable.",
    );
  });
  it("rejects missing and non-string JSON arguments", () => {
    expect(() => importLookupReplayValues(jsonLookup, [])).toThrow(
      "Import lookup parameter shape unavailable.",
    );
    const values = [...loggedValues];
    values[2] = 123;
    expect(() => importLookupReplayValues(jsonLookup, values)).toThrow(
      "Import lookup parameter shape unavailable.",
    );
  });
  it("retains only allowlisted error codes, never SQL or metadata text", () => {
    expect(
      summarizeImportPlanError({
        code: "P2010",
        message: "private SQL",
        meta: { code: "1064", message: "private" },
      }),
    ).toEqual({
      prismaCode: "P2010",
      databaseCode: "1064",
      failureClass: "unknown",
    });
    expect(
      summarizeImportPlanError({ code: "private", meta: { code: "private" } }),
    ).toEqual({
      prismaCode: null,
      databaseCode: null,
      failureClass: "unknown",
    });
    expect(summarizeImportPlanError(null)).toEqual({
      prismaCode: null,
      databaseCode: null,
      failureClass: "unknown",
    });
  });
  it("does not invoke error property getters", () => {
    expect(
      summarizeImportPlanError({
        get code() {
          throw new Error("private");
        },
        get meta() {
          throw new Error("private");
        },
      }),
    ).toEqual({
      prismaCode: null,
      databaseCode: null,
      failureClass: "unknown",
    });
  });
  it.each([
    ["Failed to deserialize private column", "deserialization"],
    ["Incorrect arguments private value", "arguments"],
    ["SQL syntax private query", "syntax"],
  ])(
    "classifies a known failure without retaining its message",
    (message, failureClass) => {
      expect(summarizeImportPlanError({ meta: { message } })).toEqual({
        prismaCode: null,
        databaseCode: null,
        failureClass,
      });
    },
  );
  it.each(["EXPLAIN", "explain", "query_plan"])(
    "reads the single plan column without assuming its name",
    (name) => {
      expect(readImportPlanColumn([{ [name]: '{"query_block":{}}' }])).toBe(
        '{"query_block":{}}',
      );
    },
  );
  it.each(
    [
      null,
      [],
      [{}],
      [{ a: "{}", b: "{}" }],
      [{ a: 42 }],
      [{ a: {} }],
      [{ a: "{}" }, { a: "{}" }],
      [null],
    ].map((rows) => ({ rows })),
  )("rejects unsupported response shapes with a fixed error", ({ rows }) => {
    expect(() => readImportPlanColumn(rows)).toThrow(
      "Import query plan response unavailable.",
    );
  });
  it("does not capture the earlier full-column source-discovery query", () => {
    const discovery =
      "SELECT `id`, `idempotencyKey`, `referenceType`, `referenceId`, `metadata` FROM `fixture`.`WeleticPointsLedgerEntry` WHERE JSON_EXTRACT(`metadata`, ?) = ? ORDER BY `id` ASC LIMIT ?";
    expect(
      captureImportLookup(discovery, '["$.sourceId","source",100001]'),
    ).toBeNull();
  });
  it("keeps captured engine SQL and parameters unchanged in memory", () => {
    const params = '["opening","type","snapshot","source",1]';
    const captured = captureImportLookup(query, params);
    expect(captured?.query).toBe(query);
    expect(captured?.values).toEqual(JSON.parse(params));
  });
  it.each([
    "DELETE FROM `WeleticPointsLedgerEntry`",
    query + "; SELECT 1",
    query + " -- extra",
    query + " /* extra */",
    "SELECT 1",
    "x".repeat(32_769),
  ])("ignores non-target/oversized query %s", (sql) => {
    expect(captureImportLookup(sql, "[]")).toBeNull();
  });
  it.each([
    "not-json",
    "{}",
    '[{"private":"value"}]',
    "[" + "0,".repeat(64) + "0]",
    "x".repeat(16_385),
  ])("ignores invalid or oversized parameters", (params) => {
    expect(captureImportLookup(query, params)).toBeNull();
  });
  it("reports only allowlisted plan fields", () => {
    const plan = {
      query_block: {
        table: {
          table_name: "WeleticPointsLedgerEntry",
          access_type: "ALL",
          key: null,
          rows_examined_per_scan: 8_100,
          attached_condition: "private-shopper",
          used_columns: ["private-field"],
        },
      },
    };
    expect(summarizeImportPlan(JSON.stringify(plan))).toEqual([
      { accessType: "ALL", chosenKey: null, estimatedRows: 8_100 },
    ]);
  });
  it("does not leak unknown index or access names", () => {
    expect(
      summarizeImportPlan(
        JSON.stringify({
          table_name: "WeleticPointsLedgerEntry",
          access_type: "private",
          key: "private-index",
          rows_examined_per_scan: -1,
        }),
      ),
    ).toEqual([
      { accessType: "unknown", chosenKey: "unknown", estimatedRows: null },
    ]);
  });
  it.each([
    "private-invalid-json",
    "{}",
    JSON.stringify({ table_name: "private-table" }),
    " ".repeat(262_145),
  ])(
    "fails with a fixed message when the plan cannot be summarized",
    (json) => {
      expect(() => summarizeImportPlan(json)).toThrow(
        "Import query plan unavailable.",
      );
    },
  );
  it("bounds nesting", () => {
    let value: unknown = { table_name: "WeleticPointsLedgerEntry" };
    for (let depth = 0; depth < 40; depth++) value = { nested: value };
    expect(() => summarizeImportPlan(JSON.stringify(value))).toThrow(
      "Import query plan unavailable.",
    );
  });
});
