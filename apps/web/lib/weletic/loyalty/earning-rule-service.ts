import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  earningRuleRetireSchema,
  earningRuleWriteSchema,
} from "./earning-rule-contract";
import { parseEarningRuleData } from "./earning-rule-input";
import {
  EarningRuleWriteError,
  retireEarningRuleInTransaction,
  writeEarningRuleInTransaction,
} from "./earning-rule-writer";

const select = {
  id: true,
  status: true,
  killSwitchActive: true,
  updatedAt: true,
  earnPolicyVersion: true,
  earningRules: {
    where: { deletedAt: null },
    orderBy: { id: "asc" },
  },
} satisfies Prisma.WeleticLoyaltyProgramSelect;

/** Internal state, not a public response. The gateway owns response projection.
 * Read-only: never initializes a program. Include hidden rule fields so another
 * editor's schedule/tier changes invalidate this editor's stale save as well.
 */
export async function readEarningRulesInTransaction(
  tx: Prisma.TransactionClient,
  storeId: string,
) {
  const program = await tx.weleticLoyaltyProgram.findUnique({
    where: { storeId },
    select,
  });
  if (!program) return { programId: null, revision: null, rules: [] };
  const revision = createHash("sha256")
    .update(
      JSON.stringify(["earning-rule-state-v1", program], (_key, value) => {
        if (typeof value === "bigint") return value.toString();
        // Object key order is not policy state. Arrays remain ordered.
        if (value && typeof value === "object" && !Array.isArray(value))
          return Object.fromEntries(
            Object.entries(value).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            ),
          );
        return value;
      }),
    )
    .digest("hex");
  return {
    programId: program.id,
    revision,
    rules: program.earningRules,
  };
}

function requireGeneration(expected: string, current: string) {
  if (expected !== current)
    throw new EarningRuleWriteError({
      code: "conflict",
      message: "Installation changed. Reload before saving earning rules",
    });
}

async function requireRevision(
  tx: Prisma.TransactionClient,
  storeId: string,
  expected: string | null,
) {
  const state = await readEarningRulesInTransaction(tx, storeId);
  if (expected !== state.revision)
    throw new EarningRuleWriteError({
      code: "conflict",
      message: "Earning rules changed. Reload before saving",
    });
}

type MutationContext = {
  tx: Prisma.TransactionClient;
  storeId: string;
  // Trusted installation generation read by the gateway on this transaction,
  // never copied from request input. Gateway must fence/recheck the live store.
  installationGeneration: string;
  input: unknown;
};

/** Caller must authorize and acquire the store write fence before this call.
 * No nested transaction or retry: stale input must be explicitly refreshed.
 */
export async function saveEarningRulesInTransaction({
  tx,
  storeId,
  installationGeneration,
  input,
}: MutationContext) {
  const data = earningRuleWriteSchema.parse(input);
  requireGeneration(
    data.expectedInstallationGeneration,
    installationGeneration,
  );
  await requireRevision(tx, storeId, data.expectedRevision);
  const affected = await writeEarningRuleInTransaction({
    tx,
    storeId,
    ruleId: data.ruleId,
    ruleData: parseEarningRuleData(data.rule),
  });
  const saved = await readEarningRulesInTransaction(tx, storeId);
  if (!saved.programId) throw new Error("Saved earning rules are unavailable");
  return { ...saved, affectedRuleId: affected.id };
}

export async function retireEarningRulesInTransaction({
  tx,
  storeId,
  installationGeneration,
  input,
}: MutationContext) {
  const data = earningRuleRetireSchema.parse(input);
  requireGeneration(
    data.expectedInstallationGeneration,
    installationGeneration,
  );
  await requireRevision(tx, storeId, data.expectedRevision);
  await retireEarningRuleInTransaction({ tx, storeId, ruleId: data.ruleId });
  const saved = await readEarningRulesInTransaction(tx, storeId);
  if (!saved.programId) throw new Error("Saved earning rules are unavailable");
  return { ...saved, affectedRuleId: data.ruleId };
}
