// Test-only helpers. Captured SQL/parameters must remain in memory and must
// never be included in assertion output, diagnostic logs or public artifacts.
export function summarizeImportPlanError(error: unknown) {
  const own = (value: unknown, key: string): unknown =>
    value && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, key)?.value
      : undefined;
  const code = own(error, "code");
  const databaseCode = own(own(error, "meta"), "code");
  const message = own(own(error, "meta"), "message");
  return {
    prismaCode:
      typeof code === "string" &&
      ["P2010", "P2024", "P2028", "P1001", "P1002", "P1017"].includes(code)
        ? code
        : null,
    databaseCode:
      typeof databaseCode === "string" &&
      /^(?:[1-5][0-9]{3})$/.test(databaseCode)
        ? databaseCode
        : null,
    failureClass:
      typeof message !== "string"
        ? "unknown"
        : message.includes("Failed to deserialize")
          ? "deserialization"
          : message.includes("Incorrect arguments")
            ? "arguments"
            : message.includes("SQL syntax")
              ? "syntax"
              : "unknown",
  };
}

export function captureImportLookup(query: string, params: string) {
  const predicate =
    /\bWHERE\b([\s\S]*?)(?:\bLIMIT\b|$)/i.exec(query)?.[1] ?? "";
  if (
    query.length > 32_768 ||
    params.length > 16_384 ||
    !/^SELECT\s/i.test(query) ||
    /;|--|\/\*/.test(query) ||
    (query.match(/\bSELECT\b/gi) ?? []).length !== 1 ||
    !query.includes("`WeleticPointsLedgerEntry`") ||
    (predicate.match(/\bOR\b/gi) ?? []).length < 2 ||
    !["idempotencyKey", "referenceType", "referenceId", "metadata"].every(
      (column) => predicate.includes(`\`${column}\``),
    )
  )
    return null;
  try {
    const values: unknown = JSON.parse(params);
    if (
      !Array.isArray(values) ||
      values.length > 64 ||
      values.some(
        (value) =>
          value !== null &&
          typeof value !== "string" &&
          typeof value !== "boolean" &&
          !(typeof value === "number" && Number.isFinite(value)),
      )
    )
      return null;
    return { query, values };
  } catch {
    return null;
  }
}

// Query-event logging erases Prisma's JSON scalar type. Restore it only at
// direct JSON_CONTAINS arguments in this known string-identity lookup.
export function importLookupReplayValues(query: string, values: unknown[]) {
  const fail = () => new Error("Import lookup parameter shape unavailable.");
  if (query.length > 32_768 || /['"\\]/.test(query)) throw fail();
  const stack: Array<{ fn: string; argument: number }> = [];
  const jsonPositions: number[] = [];
  let index = 0;
  for (const token of query.matchAll(/`[^`]*`|([A-Z_]+)\s*\(|([(),?])/gi)) {
    if (token[0].startsWith("`")) {
      if (token[0].includes("?")) throw fail();
      continue;
    }
    if (token[1] || token[2] === "(")
      stack.push({ fn: token[1]?.toUpperCase() ?? "", argument: 0 });
    else if (token[2] === ")") {
      if (!stack.pop()) throw fail();
    } else if (token[2] === "," && stack.length)
      stack[stack.length - 1].argument++;
    else if (token[2] === "?") {
      const parent = stack[stack.length - 1];
      if (parent?.fn === "JSON_CONTAINS" && parent.argument < 2)
        jsonPositions.push(index);
      index++;
    }
  }
  if (
    stack.length ||
    index !== values.length ||
    jsonPositions.length !== 4 ||
    jsonPositions.some((position) => typeof values[position] !== "string")
  )
    throw fail();
  return values.map((value, position) =>
    jsonPositions.includes(position) ? JSON.stringify(value) : value,
  );
}

export function readImportPlanColumn(rows: unknown): string {
  const fail = () => new Error("Import query plan response unavailable.");
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    rows[0] === null ||
    typeof rows[0] !== "object" ||
    Array.isArray(rows[0])
  )
    throw fail();
  const columns = Object.values(rows[0]);
  if (
    columns.length !== 1 ||
    typeof columns[0] !== "string" ||
    columns[0].length > 262_144
  )
    throw fail();
  return columns[0];
}

const accessTypes = new Set([
  "ALL",
  "index",
  "range",
  "ref",
  "eq_ref",
  "const",
  "system",
  "index_merge",
  "ref_or_null",
  "fulltext",
  "unique_subquery",
  "index_subquery",
]);
const knownKeys = new Set([
  "PRIMARY",
  "WeleticPointsLedgerEntry_accountId_createdAt_idx",
  "WeleticPointsLedgerEntry_accountId_sequenceNumber_key",
  "WeleticPointsLedgerEntry_referenceType_referenceId_idx",
  "WeleticPointsLedgerEntry_storeId_idempotencyKey_key",
]);

export function summarizeImportPlan(json: string) {
  const fail = () => new Error("Import query plan unavailable.");
  if (json.length > 262_144) throw fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw fail();
  }
  const tables: Array<{
    accessType: string;
    chosenKey: string | null;
    estimatedRows: number | null;
  }> = [];
  let visited = 0;
  function visit(value: unknown, depth: number) {
    if (++visited > 2_000 || depth > 32) throw fail();
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (Object.hasOwn(record, "table_name")) {
      if (
        record.table_name !== "WeleticPointsLedgerEntry" ||
        tables.length >= 8
      )
        throw fail();
      tables.push({
        accessType:
          typeof record.access_type === "string" &&
          accessTypes.has(record.access_type)
            ? record.access_type
            : "unknown",
        chosenKey:
          record.key == null
            ? null
            : typeof record.key === "string" && knownKeys.has(record.key)
              ? record.key
              : "unknown",
        estimatedRows:
          typeof record.rows_examined_per_scan === "number" &&
          Number.isFinite(record.rows_examined_per_scan) &&
          record.rows_examined_per_scan >= 0
            ? record.rows_examined_per_scan
            : null,
      });
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  }
  visit(parsed, 0);
  if (!tables.length) throw fail();
  return tables;
}
