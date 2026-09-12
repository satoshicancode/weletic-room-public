import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { assertLoyaltyMaintenanceWriteAllowed } from "./maintenance-write-fence";
import {
  defaultLoyaltyNudgeSettings,
  loyaltyNudgeRequestSchema,
  loyaltyNudgeSettingsSchema,
} from "./nudge-contract";
import { lockLoyaltyProgramRowIfPresent } from "./program-write-fence";

const select = {
  id: true,
  storeId: true,
  metadata: true,
  updatedAt: true,
} satisfies Prisma.WeleticLoyaltyProgramSelect;
type Program = Prisma.WeleticLoyaltyProgramGetPayload<{
  select: typeof select;
}>;
export class LoyaltyNudgeConflictError extends Error {
  constructor() {
    super("Loyalty nudges changed; reload before saving");
    this.name = "LoyaltyNudgeConflictError";
  }
}
function decode(value: Prisma.JsonValue | null) {
  if (value !== null && (typeof value !== "object" || Array.isArray(value)))
    throw new Error("Invalid loyalty nudge metadata");
  const metadata = value ?? {};
  const sequence = Object.hasOwn(metadata, "loyaltyNudgeSequence")
    ? metadata.loyaltyNudgeSequence
    : 0;
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0
  )
    throw new Error("Invalid loyalty nudge revision");
  const settings = Object.hasOwn(metadata, "loyaltyNudges")
    ? loyaltyNudgeSettingsSchema.parse(metadata.loyaltyNudges)
    : defaultLoyaltyNudgeSettings();
  return { metadata, sequence, settings };
}
function project(storeId: string, program: Program | null) {
  if (program && program.storeId !== storeId)
    throw new LoyaltyNudgeConflictError();
  const { settings } = decode(program?.metadata ?? null);
  return {
    revision: createHash("sha256")
      .update(
        JSON.stringify({
          storeId,
          programId: program?.id ?? null,
          metadata: program?.metadata ?? null,
          updatedAt: program?.updatedAt.toISOString() ?? null,
        }),
      )
      .digest("hex"),
    programConfigured: program !== null,
    settings,
  };
}
export async function readLoyaltyNudgesInTransaction(
  tx: Prisma.TransactionClient,
  storeId: string,
) {
  return project(
    storeId,
    await tx.weleticLoyaltyProgram.findUnique({ where: { storeId }, select }),
  );
}
/** Internal primitive. Signed gateway authenticates staff and locks the store
 * lifecycle first; this acquires program second. No implicit setup or retry. */
export async function saveLoyaltyNudgesInTransaction({
  tx,
  storeId,
  installationGeneration,
  request,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  installationGeneration: string;
  request: unknown;
}) {
  const data = loyaltyNudgeRequestSchema.parse(request);
  if (data.operation !== "save") throw new Error("Save required");
  if (data.expectedInstallationGeneration !== installationGeneration)
    throw new LoyaltyNudgeConflictError();
  const locked = await lockLoyaltyProgramRowIfPresent({ tx, storeId });
  if (!locked) throw new LoyaltyNudgeConflictError();
  const program = await tx.weleticLoyaltyProgram.findUnique({
    where: { storeId },
    select,
  });
  if (!program || program.id !== locked.id || program.storeId !== storeId)
    throw new LoyaltyNudgeConflictError();
  assertLoyaltyMaintenanceWriteAllowed({ storeId, metadata: program.metadata });
  const current = project(storeId, program);
  const { metadata, sequence } = decode(program.metadata);
  if (
    current.revision !== data.expectedRevision ||
    sequence === Number.MAX_SAFE_INTEGER
  )
    throw new LoyaltyNudgeConflictError();
  const changed = await tx.weleticLoyaltyProgram.updateMany({
    where: {
      id: program.id,
      storeId,
      updatedAt: program.updatedAt,
      metadata: { equals: program.metadata ?? Prisma.DbNull },
    },
    data: {
      metadata: {
        ...metadata,
        loyaltyNudgeSequence: sequence + 1,
        loyaltyNudges: data.settings,
      } as Prisma.InputJsonObject,
    },
  });
  if (changed.count !== 1) throw new LoyaltyNudgeConflictError();
  return readLoyaltyNudgesInTransaction(tx, storeId);
}
