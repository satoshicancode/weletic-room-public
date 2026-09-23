// Exact, read-only release preflight for the ledger source-provenance selector.
// Fixed issue codes avoid printing target schema details or customer data.
export type ProvenanceLedgerTable = {
  tableType: string;
  engine: string | null;
};

export type ProvenanceSourceColumn = {
  columnType: string;
  nullable: string;
  defaultValue: string | null;
  extra: string;
  collationName: string | null;
  generationExpression: string | null;
};

export type ProvenanceSourceIndex = {
  columnName: string | null;
  nonUnique: number;
  sequence: number;
  prefixLength: number | null;
  indexType: string;
  visible: string;
};

const expectedExpression =
  "cast(json_unquote(json_extract(metadata,'$.sourceid'))aschar(191)charsetutf8mb4)";

function matchesSourceExpression(expression: string | null) {
  if (!expression) return false;
  // MySQL may escape quoted JSON paths in information_schema even though the
  // stored generated expression addresses the same key. Preserve path case.
  const unescaped = expression.replace(/\\+'/g, "'");
  const path = unescaped.match(
    /json_extract\([^,]+,\s*(?:_[a-z0-9]+)?'([^']+)'\)/i,
  )?.[1];
  if (path !== "$.sourceId") return false;
  const normalized = unescaped
    .replaceAll("`", "")
    .replace(/_[a-z0-9]+(?=')/gi, "")
    .replace(/\s+/g, "")
    .toLowerCase();
  return normalized === expectedExpression;
}

export function auditHistoricalImportProvenanceIndex({
  tables,
  columns,
  indexes,
}: {
  tables: ProvenanceLedgerTable[];
  columns: ProvenanceSourceColumn[];
  indexes: ProvenanceSourceIndex[];
}) {
  const issues: string[] = [];
  if (
    tables.length !== 1 ||
    tables[0].tableType !== "BASE TABLE" ||
    tables[0].engine !== "InnoDB"
  )
    issues.push("ledger_table_incompatible");

  const column = columns[0];
  if (
    columns.length !== 1 ||
    column.columnType.toLowerCase() !== "varchar(191)" ||
    column.nullable !== "YES" ||
    column.defaultValue !== null ||
    column.extra.toUpperCase() !== "VIRTUAL GENERATED" ||
    column.collationName !== "utf8mb4_bin"
  )
    issues.push("source_column_incompatible");
  if (
    columns.length !== 1 ||
    !matchesSourceExpression(column.generationExpression)
  )
    issues.push("source_expression_incompatible");

  const index = indexes[0];
  if (
    indexes.length !== 1 ||
    index.columnName !== "importSourceId" ||
    index.nonUnique !== 1 ||
    index.sequence !== 1 ||
    index.prefixLength !== null ||
    index.indexType !== "BTREE" ||
    index.visible !== "YES"
  )
    issues.push("source_index_incompatible");
  return { ready: issues.length === 0, issues };
}
