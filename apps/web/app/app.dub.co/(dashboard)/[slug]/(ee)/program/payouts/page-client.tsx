"use client";

import { PayoutProfileReviews } from "./payout-profile-reviews";
import { PayoutStats } from "./payout-stats";
import { PayoutTable } from "./payout-table";

export function ProgramPayoutsPageClient() {
  return (
    <>
      <PayoutProfileReviews />
      <PayoutStats />
      <div className="my-4">
        <PayoutTable />
      </div>
    </>
  );
}
