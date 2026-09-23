import { describe, expect, it } from "vitest";
import {
  auditHistoricalImportProvenanceIndex,
  type ProvenanceLedgerTable,
  type ProvenanceSourceColumn,
  type ProvenanceSourceIndex,
} from "../../lib/weletic/loyalty/historical-import-provenance-index-contract";

const table: ProvenanceLedgerTable = {
  tableType: "BASE TABLE",
  engine: "InnoDB",
};
const column: ProvenanceSourceColumn = {
  columnType: "varchar(191)",
  nullable: "YES",
  defaultValue: null,
  extra: "VIRTUAL GENERATED",
  collationName: "utf8mb4_bin",
  generationExpression:
    "cast(json_unquote(json_extract(`metadata`,_latin1\\'$.sourceId\\')) as char(191) charset utf8mb4)",
};
const index: ProvenanceSourceIndex = {
  columnName: "importSourceId",
  nonUnique: 1,
  sequence: 1,
  prefixLength: null,
  indexType: "BTREE",
  visible: "YES",
};
const run = ({
  tables = [table],
  columns = [column],
  indexes = [index],
}: {
  tables?: ProvenanceLedgerTable[];
  columns?: ProvenanceSourceColumn[];
  indexes?: ProvenanceSourceIndex[];
} = {}) => auditHistoricalImportProvenanceIndex({ tables, columns, indexes });

describe("historical import provenance-index preflight", () => {
  it("accepts only the generated, binary-collated, full-width lookup", () => {
    expect(run()).toEqual({ ready: true, issues: [] });
  });

  it.each([
    { indexes: [], issue: "source_index_incompatible" },
    {
      indexes: [{ ...index, prefixLength: 64 }],
      issue: "source_index_incompatible",
    },
    {
      indexes: [{ ...index, visible: "NO" }],
      issue: "source_index_incompatible",
    },
    {
      indexes: [{ ...index, columnName: "storeId" }],
      issue: "source_index_incompatible",
    },
    {
      columns: [{ ...column, extra: "" }],
      issue: "source_column_incompatible",
    },
    {
      columns: [{ ...column, collationName: "utf8mb4_unicode_ci" }],
      issue: "source_column_incompatible",
    },
    {
      columns: [
        {
          ...column,
          generationExpression: column.generationExpression!.replace(
            "sourceId",
            "sourceid",
          ),
        },
      ],
      issue: "source_expression_incompatible",
    },
    {
      columns: [
        {
          ...column,
          generationExpression:
            "json_unquote(json_extract(metadata, '$.sourceId'))",
        },
      ],
      issue: "source_expression_incompatible",
    },
    {
      tables: [{ ...table, engine: "MyISAM" }],
      issue: "ledger_table_incompatible",
    },
  ])(
    "rejects an incompatible table, generated column or index %#",
    (variation) => {
      expect(run(variation)).toMatchObject({
        ready: false,
        issues: expect.arrayContaining([variation.issue]),
      });
    },
  );

  it("fails closed when all target metadata is absent", () => {
    expect(run({ tables: [], columns: [], indexes: [] })).toEqual({
      ready: false,
      issues: [
        "ledger_table_incompatible",
        "source_column_incompatible",
        "source_expression_incompatible",
        "source_index_incompatible",
      ],
    });
  });
});
