import { escapeCsvCell, escapeCsvUntrustedTextCell } from "./csv";
import type { MerchantRedemptionRowExportResponse } from "./redemption-row-export-contract";

type Row = MerchantRedemptionRowExportResponse["rows"][number];

function exactIntegerCell(value: string) {
  if (!/^(?:0|[1-9]\d*)$/.test(value))
    throw new Error("Invalid redemption integer in CSV export");
  return escapeCsvCell(value);
}

export function merchantRedemptionRowCsv(rows: Row[]) {
  const lines = [
    [
      "account_pseudonym",
      "redemption_pseudonym",
      "created_at_utc",
      "current_status",
      "artifact_kind",
      "points_spent",
      "used_at_utc",
    ],
    ...rows.map((row) => [
      row.accountPseudonym,
      row.redemptionPseudonym,
      row.createdAt,
      row.currentStatus,
      row.artifactKind,
      row.pointsSpent,
      row.usedAt ?? "",
    ]),
  ];
  return (
    lines
      .map((line, index) =>
        line
          .map((value, column) =>
            index > 0 && column === 5
              ? exactIntegerCell(value)
              : escapeCsvUntrustedTextCell(value),
          )
          .join(","),
      )
      .join("\r\n") + "\r\n"
  );
}
