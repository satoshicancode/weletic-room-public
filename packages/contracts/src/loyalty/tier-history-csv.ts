import { escapeCsvUntrustedTextCell } from "./csv";
import type { MerchantTierHistoryExportResponse } from "./tier-history-export-contract";

type Row = MerchantTierHistoryExportResponse["rows"][number];

export function merchantTierHistoryCsv(rows: Row[]) {
  const lines = [
    [
      "account_pseudonym",
      "effective_at_utc",
      "from_tier_current_name",
      "to_tier_current_name",
      "change_reason",
    ],
    ...rows.map((row) => [
      row.accountPseudonym,
      row.effectiveAt,
      row.fromTierCurrentName,
      row.toTierCurrentName,
      row.changeReason,
    ]),
  ];
  return (
    lines
      .map((line) => line.map(escapeCsvUntrustedTextCell).join(","))
      .join("\r\n") + "\r\n"
  );
}
