import { createWeleticId } from "@/lib/weletic/ids";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ReviewError } from "./contracts";
import {
  DEFAULT_OPEN_REVIEW_POLICY,
  openReviewPolicySnapshot,
  openReviewPolicyWriteSchema,
} from "./open-submission-policy";
import { withReviewMutation } from "./transaction";

const actorSchema = z
  .object({
    appId: z.string().min(1).max(191),
    shopifyUserId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  })
  .strict();

/** Internal locking read. Caller holds the operational store lock. Raw current
 * read deliberately avoids an older Repeatable Read snapshot established by auth.
 * This is history, not submission permission: the shopper writer must additionally
 * match installationGeneration before honoring an enabled policy after reinstall.
 */
export async function readCurrentOpenReviewPolicy(
  tx: Prisma.TransactionClient,
  storeId: string,
) {
  z.string().min(1).max(191).parse(storeId);
  const rows = await tx.$queryRaw<
    Array<{
      revision: number;
      snapshot: Prisma.JsonValue;
      contentDigest: string;
      installationGeneration: string;
    }>
  >(Prisma.sql`
    SELECT revision, snapshot, contentDigest, installationGeneration
    FROM WeleticOpenReviewPolicy WHERE storeId = ${storeId}
    ORDER BY revision DESC LIMIT 1 FOR UPDATE
  `);
  const row = rows[0];
  if (!row)
    return {
      revision: 0,
      policy: { ...DEFAULT_OPEN_REVIEW_POLICY },
      installationGeneration: null,
    };
  z.number().int().min(1).max(2147483647).parse(row.revision);
  const parsed = openReviewPolicySnapshot(
    typeof row.snapshot === "string" ? JSON.parse(row.snapshot) : row.snapshot,
  );
  if (parsed.contentDigest !== row.contentDigest)
    throw new ReviewError(
      "unavailable",
      "Open review policy integrity check failed",
    );
  return {
    revision: row.revision,
    policy: parsed.policy,
    installationGeneration: row.installationGeneration,
  };
}

/** No public route. The required callback must revalidate the signed merchant
 * identity and store ownership inside this transaction, returning trusted actor
 * attribution. Neither caller JSON nor this function authenticates a merchant.
 */
export async function createOpenReviewPolicyRevision(
  storeId: string,
  input: unknown,
  authorize: (
    tx: Prisma.TransactionClient,
  ) => Promise<z.infer<typeof actorSchema>>,
) {
  z.string().min(1).max(191).parse(storeId);
  const command = openReviewPolicyWriteSchema.parse(input);
  return withReviewMutation(
    storeId,
    async (tx) => {
      const actor = actorSchema.parse(await authorize(tx));
      const current = await readCurrentOpenReviewPolicy(tx, storeId);
      if (current.revision !== command.expectedRevision)
        throw new ReviewError(
          "conflict",
          "Open review policy changed; reload and retry",
        );
      const { policy, contentDigest } = openReviewPolicySnapshot(
        command.policy,
      );
      const revision = current.revision + 1;
      await tx.weleticOpenReviewPolicy.create({
        data: {
          id: createWeleticId("wrevopenpolicy_"),
          storeId,
          revision,
          snapshot: policy,
          contentDigest,
          installationGeneration: command.expectedInstallationGeneration,
          ...actor,
        },
      });
      return { revision, policy };
    },
    command.expectedInstallationGeneration,
  );
}
