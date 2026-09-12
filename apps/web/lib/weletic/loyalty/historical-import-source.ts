import { createHash } from "node:crypto";
import Papa from "papaparse";
import {
  HISTORICAL_IMPORT_MAX_SOURCE_BYTES,
  HISTORICAL_IMPORT_MAX_SOURCE_ROWS,
  historicalImportRowSchema,
  historicalImportSourceSchema,
  type HistoricalImportRow,
} from "./historical-import-contract";

export {
  HISTORICAL_IMPORT_MAX_SOURCE_BYTES,
  HISTORICAL_IMPORT_MAX_SOURCE_ROWS,
} from "./historical-import-contract";
const csvColumns = [
  "shopifyCustomerId",
  "openingBalance",
  "birthdayMonth",
  "birthdayDay",
  "tierId",
] as const;

export class HistoricalImportSourceError extends Error {
  constructor(
    readonly code:
      | "invalid_source"
      | "source_mismatch"
      | "invalid_row"
      | "duplicate_customer",
    readonly rowNumber?: number,
  ) {
    // Never include source content or shopper identity in errors/logs.
    super(
      `Historical import ${code}${rowNumber ? ` at row ${rowNumber}` : ""}`,
    );
    this.name = "HistoricalImportSourceError";
  }
}

function parseCsv(text: string): unknown[] {
  const parsed = Papa.parse<string[]>(text, {
    delimiter: ",",
    skipEmptyLines: true,
    // Header plus one overflow row: stop parsing before allocating an entire
    // adversarial file of tiny records, and never silently truncate an import.
    preview: HISTORICAL_IMPORT_MAX_SOURCE_ROWS + 2,
  });
  if (
    parsed.errors.length ||
    parsed.data.length < 2 ||
    parsed.data.length > HISTORICAL_IMPORT_MAX_SOURCE_ROWS + 1 ||
    parsed.meta.truncated
  )
    throw new HistoricalImportSourceError("invalid_source");
  const [headers, ...records] = parsed.data;
  if (
    new Set(headers).size !== headers.length ||
    headers.some(
      (header) => !csvColumns.includes(header as (typeof csvColumns)[number]),
    ) ||
    !headers.includes("shopifyCustomerId") ||
    !headers.includes("openingBalance") ||
    headers.includes("birthdayMonth") !== headers.includes("birthdayDay")
  )
    throw new HistoricalImportSourceError("invalid_source");
  return records.map((values, index) => {
    if (values.length !== headers.length)
      throw new HistoricalImportSourceError("invalid_row", index + 1);
    const record = Object.fromEntries(
      headers.map((header, column) => [header, values[column]]),
    );
    const hasBirthday = Boolean(record.birthdayMonth || record.birthdayDay);
    if (
      hasBirthday &&
      (!/^[1-9][0-9]?$/.test(record.birthdayMonth ?? "") ||
        !/^[1-9][0-9]?$/.test(record.birthdayDay ?? ""))
    )
      throw new HistoricalImportSourceError("invalid_row", index + 1);
    return {
      shopifyCustomerId: record.shopifyCustomerId,
      openingBalance: record.openingBalance,
      ...(hasBirthday
        ? {
            birthday: {
              month: Number(record.birthdayMonth),
              day: Number(record.birthdayDay),
            },
          }
        : {}),
      ...(record.tierId ? { tierId: record.tierId } : {}),
    };
  });
}

/** Server-side source parsing; no customer lookup, enrollment or balance writes. */
export function parseHistoricalImportSource({
  bytes,
  source,
}: {
  bytes: Uint8Array;
  source: unknown;
}) {
  const descriptor = historicalImportSourceSchema.safeParse(source);
  if (
    !descriptor.success ||
    !bytes.byteLength ||
    bytes.byteLength > HISTORICAL_IMPORT_MAX_SOURCE_BYTES
  )
    throw new HistoricalImportSourceError("invalid_source");
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  if (sourceSha256 !== descriptor.data.sha256)
    throw new HistoricalImportSourceError("source_mismatch");
  let decoded: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    decoded =
      descriptor.data.format === "csv" ? parseCsv(text) : JSON.parse(text);
  } catch (error) {
    if (error instanceof HistoricalImportSourceError) throw error;
    throw new HistoricalImportSourceError("invalid_source");
  }
  return {
    source: { ...descriptor.data, sha256: sourceSha256 },
    ...proveHistoricalImportRows(decoded),
  };
}

/** The same canonical form is used at upload and when re-reading snapshots. */
export function proveHistoricalImportRows(decoded: unknown) {
  if (
    !Array.isArray(decoded) ||
    !decoded.length ||
    decoded.length > HISTORICAL_IMPORT_MAX_SOURCE_ROWS
  )
    throw new HistoricalImportSourceError("invalid_source");
  const customers = new Set<string>();
  const rows: HistoricalImportRow[] = decoded.map((value, index) => {
    const parsed = historicalImportRowSchema.safeParse(value);
    if (!parsed.success)
      throw new HistoricalImportSourceError("invalid_row", index + 1);
    const row = parsed.data;
    if (customers.has(row.shopifyCustomerId))
      throw new HistoricalImportSourceError("duplicate_customer", index + 1);
    customers.add(row.shopifyCustomerId);
    return row;
  });
  // Schema parsing fixes field order. Row order is significant for resumable batches.
  const normalizedSha256 = createHash("sha256")
    .update(JSON.stringify({ version: 1, rows }))
    .digest("hex");
  return {
    normalizedSha256,
    rows,
    totalOpeningBalance: rows
      .reduce((sum, row) => sum + BigInt(row.openingBalance), BigInt(0))
      .toString(),
  };
}
