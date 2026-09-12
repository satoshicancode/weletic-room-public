import { describe, expect, it } from "vitest";
import {
  auditHistoricalImportSchema,
  HISTORICAL_OUTBOX_VALUES,
  IMPORT_SCHEMA_COLUMNS,
  IMPORT_SCHEMA_INDEXES,
  IMPORT_SCHEMA_TABLES,
  planImportOutboxEnum,
  sqlEnum,
  type ImportSchemaColumn,
  type ImportSchemaIndex,
} from "../../lib/weletic/loyalty/historical-import-schema-contract";

function fixture() {
  const columns: ImportSchemaColumn[] = Object.entries(
    IMPORT_SCHEMA_COLUMNS,
  ).flatMap(([tableName, fields]) =>
    Object.entries(fields).map(([columnName, spec]) => ({
      tableName,
      columnName,
      columnType: spec.type,
      nullable: spec.nullable,
      defaultValue: spec.defaultValue,
      extra: "",
      collationName: /^(varchar|enum)/.test(spec.type)
        ? "utf8mb4_unicode_ci"
        : null,
    })),
  );
  columns.push(
    {
      tableName: "WeleticLoyaltyOutboxJob",
      columnName: "jobType",
      columnType: sqlEnum([
        ...HISTORICAL_OUTBOX_VALUES,
        "LOYALTY_COMMUNICATION",
        "HISTORICAL_IMPORT_COMMIT",
        "HISTORICAL_IMPORT_ROLLBACK",
      ]),
      nullable: "NO",
      defaultValue: null,
      extra: "",
      collationName: "utf8mb4_unicode_ci",
    },
    {
      tableName: "WeleticLoyaltyTierHistory",
      columnName: "toTierId",
      columnType: "varchar(191)",
      nullable: "YES",
      defaultValue: null,
      extra: "",
      collationName: "utf8mb4_unicode_ci",
    },
  );
  const indexes: ImportSchemaIndex[] = Object.entries(
    IMPORT_SCHEMA_INDEXES,
  ).flatMap(([tableName, specs]) =>
    specs.flatMap((spec, number) =>
      spec.columns.map((columnName, position) => ({
        tableName,
        indexName: `index_${number}`,
        columnName,
        nonUnique: spec.unique ? 0 : 1,
        sequence: position + 1,
        prefixLength: null,
      })),
    ),
  );
  return {
    columns,
    indexes,
    tables: IMPORT_SCHEMA_TABLES.map((tableName) => ({
      tableName,
      tableType: "BASE TABLE",
      engine: "InnoDB",
    })),
  };
}

describe("historical import schema release preflight", () => {
  it("accepts the complete contract", () => {
    expect(auditHistoricalImportSchema(fixture())).toEqual({
      ready: true,
      issues: [],
    });
  });
  it.each(["MyISAM", "VIEW", "missing"])("blocks %s table metadata", (kind) => {
    const data = fixture();
    if (kind === "missing") data.tables.pop();
    else if (kind === "VIEW") data.tables[0].tableType = kind;
    else data.tables[0].engine = kind;
    expect(auditHistoricalImportSchema(data).ready).toBe(false);
  });
  it("rejects unapproved columns and unique constraints", () => {
    const data = fixture();
    data.columns.push({ ...data.columns[0], columnName: "unexpectedRequired" });
    expect(auditHistoricalImportSchema(data).ready).toBe(false);
    data.columns.pop();
    data.indexes.push({
      ...data.indexes[0],
      indexName: "unexpected_unique",
      columnName: "storeId",
    });
    expect(auditHistoricalImportSchema(data).ready).toBe(false);
  });
  it("rejects an extra prefixed unique index alongside the required full-width key", () => {
    const data = fixture();
    const approved = data.indexes.filter(
      (index) =>
        index.tableName === "WeleticLoyaltyImportRowSnapshot" &&
        index.indexName === "index_2",
    );
    data.indexes.push(
      ...approved.map((index) => ({
        ...index,
        indexName: "prefix_duplicate",
        prefixLength: index.columnName === "shopifyCustomerId" ? 1 : null,
      })),
    );
    expect(auditHistoricalImportSchema(data).issues).toContain(
      "index:WeleticLoyaltyImportRowSnapshot:unexpected_unique",
    );
  });
  it.each(IMPORT_SCHEMA_TABLES)("blocks a missing or partial %s", (table) => {
    const data = fixture();
    data.columns = data.columns.filter((column) => column.tableName !== table);
    expect(auditHistoricalImportSchema(data).ready).toBe(false);
  });
  it("blocks every missing column independently", () => {
    const data = fixture();
    for (const missing of data.columns) {
      expect(
        auditHistoricalImportSchema({
          ...data,
          columns: data.columns.filter((column) => column !== missing),
        }).ready,
      ).toBe(false);
    }
  });
  it.each(["type", "nullability", "default", "generated", "collation"])(
    "blocks wrong %s",
    (field) => {
      const data = fixture();
      const column = data.columns[0];
      if (field === "type") column.columnType = "varchar(64)";
      if (field === "nullability") column.nullable = "YES";
      if (field === "default") column.defaultValue = "unexpected";
      if (field === "generated") column.extra = "VIRTUAL GENERATED";
      if (field === "collation") column.collationName = "utf8mb4_bin";
      expect(auditHistoricalImportSchema(data).ready).toBe(false);
    },
  );
  it("blocks every missing index, shortened key and missing uniqueness", () => {
    const data = fixture();
    for (const index of data.indexes) {
      expect(
        auditHistoricalImportSchema({
          ...data,
          indexes: data.indexes.filter((item) => item !== index),
        }).ready,
      ).toBe(false);
    }
    data.indexes[0].prefixLength = 10;
    expect(auditHistoricalImportSchema(data).ready).toBe(false);
    data.indexes[0].prefixLength = null;
    data.indexes[0].nonUnique = 1;
    expect(auditHistoricalImportSchema(data).ready).toBe(false);
  });
  it("blocks non-null rollback destination", () => {
    const data = fixture();
    data.columns.at(-1)!.nullable = "NO";
    expect(auditHistoricalImportSchema(data).issues).toContain(
      "tier_history:nullable_destination_required",
    );
  });
  it("proposes additive labels for all known lineages without changing ordinals", () => {
    for (const local of [[], ["REVIEW_POINTS_FULFILL"]]) {
      for (const suffix of [
        [],
        ["LOYALTY_COMMUNICATION"],
        ["HISTORICAL_IMPORT_COMMIT", "HISTORICAL_IMPORT_ROLLBACK"],
      ]) {
        const current = [...HISTORICAL_OUTBOX_VALUES, ...local, ...suffix];
        const plan = planImportOutboxEnum(sqlEnum(current));
        expect(plan.proposed.slice(0, current.length)).toEqual(current);
        expect(plan.ready).toBe(false);
        expect(planImportOutboxEnum(sqlEnum(plan.proposed)).ready).toBe(true);
        const data = fixture();
        data.columns.at(-2)!.columnType = sqlEnum(plan.proposed);
        expect(auditHistoricalImportSchema(data).ready).toBe(true);
      }
    }
  });
  it("rejects unknown labels, reordered values and partial import enums", () => {
    for (const values of [
      [...HISTORICAL_OUTBOX_VALUES, "UNKNOWN"],
      [...HISTORICAL_OUTBOX_VALUES].reverse(),
      [...HISTORICAL_OUTBOX_VALUES, "HISTORICAL_IMPORT_COMMIT"],
    ]) {
      expect(() => planImportOutboxEnum(sqlEnum(values))).toThrow(
        "Unrecognized",
      );
      const data = fixture();
      data.columns.at(-2)!.columnType = sqlEnum(values);
      expect(auditHistoricalImportSchema(data).ready).toBe(false);
    }
  });
});
