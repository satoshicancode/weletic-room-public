import { escapeCsvCell, escapeCsvUntrustedTextCell } from "./csv";
import type { MerchantLedgerRowExportResponse } from "./ledger-row-export-contract";

type Row = MerchantLedgerRowExportResponse["rows"][number];

function exactIntegerCell(value: string) {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value))
    throw new Error("Invalid ledger integer in CSV export");
  return escapeCsvCell(value);
}

export function merchantLedgerRowCsv(rows: Row[]) {
  const lines = [
    [
      "account_pseudonym",
      "account_sequence",
      "created_at_utc",
      "entry_type",
      "points_delta",
      "pending_delta",
      "balance_after",
    ],
    ...rows.map((row) => [
      row.accountPseudonym,
      String(row.sequenceNumber),
      row.createdAt,
      row.entryType,
      row.pointsDelta,
      row.pendingDelta,
      row.balanceAfter,
    ]),
  ];
  return (
    lines
      .map((line, index) =>
        line
          .map((value, column) =>
            index > 0 && column >= 4
              ? exactIntegerCell(value)
              : escapeCsvUntrustedTextCell(value),
          )
          .join(","),
      )
      .join("\r\n") + "\r\n"
  );
}
