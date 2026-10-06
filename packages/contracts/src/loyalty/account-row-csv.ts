import {
  merchantAccountRowExportResponseSchema,
  type MerchantAccountRowExportResponse,
} from "./account-row-export-contract";
import { escapeCsvUntrustedTextCell } from "./csv";

type Row = MerchantAccountRowExportResponse["rows"][number];

export function merchantAccountRowCsv(rows: Row[]) {
  const valid = merchantAccountRowExportResponseSchema.parse({
    status: "available",
    coverage: "current_retained_nonredacted_accounts_by_enrollment",
    installationGeneration: "csv",
    filter: { startAt: null, endAt: null },
    rows,
  });
  const lines = [
    [
      "account_pseudonym",
      "enrolled_at_utc",
      "current_status",
      "current_tier_order",
      "cached_points_balance",
      "cached_pending_points",
      "lifetime_points_earned",
      "lifetime_points_redeemed",
    ],
    ...valid.rows.map((row) => [
      row.accountPseudonym,
      row.enrolledAt,
      row.accountStatus,
      row.currentTierOrder === null ? "" : String(row.currentTierOrder),
      row.cachedPointsBalance,
      row.cachedPendingPoints,
      row.lifetimePointsEarned,
      row.lifetimePointsRedeemed,
    ]),
  ];
  return (
    lines
      .map((line) => line.map(escapeCsvUntrustedTextCell).join(","))
      .join("\r\n") + "\r\n"
  );
}
