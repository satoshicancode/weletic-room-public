import { Prisma } from "@prisma/client";
import { REVIEW_FLOW_HANDLES } from "./flow-contract";

/** Applied before the queue page limit. Keep malformed JSON visible to terminal
 * payload validation: SQL NOT(NULL) is NULL, not true. This requires an explicit
 * absent/JSON-null path branch, verified against the supported MySQL runtime.
 */
export function reviewFlowCandidateWhere(): Prisma.WeleticLoyaltyOutboxJobWhereInput {
  return {
    OR: [
      { payload: { path: "$.handle", equals: Prisma.AnyNull } },
      {
        NOT: {
          jobType: "FLOW_TRIGGER",
          OR: Object.values(REVIEW_FLOW_HANDLES).map((handle) => ({
            payload: { path: "$.handle", equals: handle },
          })),
          store: {
            // Retired privacy owners must reach terminal handling, not wait
            // forever merely because erasure removed their module settings.
            complianceState: { not: "redacted" },
            OR: [
              { reviewSettings: { is: null } },
              { reviewSettings: { is: { enabled: false } } },
              { storeAccessState: { in: ["pending_approval", "suspended"] } },
              { complianceState: "frozen" },
            ],
          },
        },
      },
    ],
  };
}
