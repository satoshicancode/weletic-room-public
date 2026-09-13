import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { loyaltyAppearanceRequestSchema } from "./appearance-contract";
import { normalizeStoredLoyaltyBranding } from "./branding";
import { assertLoyaltyMaintenanceWriteAllowed } from "./maintenance-write-fence";
import { lockLoyaltyProgramRowIfPresent } from "./program-write-fence";

const select = {
  id: true,
  storeId: true,
  name: true,
  branding: true,
  metadata: true,
  updatedAt: true,
} satisfies Prisma.WeleticLoyaltyProgramSelect;
type Program = Prisma.WeleticLoyaltyProgramGetPayload<{
  select: typeof select;
}>;

export class LoyaltyAppearanceConflictError extends Error {
  constructor() {
    super("Loyalty appearance changed; reload before saving");
    this.name = "LoyaltyAppearanceConflictError";
  }
}

function readMetadata(value: Prisma.JsonValue | null) {
  if (value !== null && (typeof value !== "object" || Array.isArray(value)))
    throw new Error("Invalid loyalty appearance metadata");
  const metadata = value ?? {};
  const sequence = Object.hasOwn(metadata, "loyaltyAppearanceSequence")
    ? metadata.loyaltyAppearanceSequence
    : 0;
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0
  )
    throw new Error("Invalid loyalty appearance revision");
  return { metadata, sequence };
}

function project(storeId: string, program: Program | null) {
  if (program && program.storeId !== storeId)
    throw new LoyaltyAppearanceConflictError();
  const { sequence } = readMetadata(program?.metadata ?? null);
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        storeId,
        programId: program?.id ?? null,
        name: program?.name ?? null,
        branding: program?.branding ?? null,
        updatedAt: program?.updatedAt.toISOString() ?? null,
        sequence,
      }),
    )
    .digest("hex");
  return {
    revision,
    programConfigured: program !== null,
    branding: normalizeStoredLoyaltyBranding(program?.branding, program?.name),
  };
}

export async function readLoyaltyAppearanceInTransaction(
  tx: Prisma.TransactionClient,
  storeId: string,
) {
  return project(
    storeId,
    await tx.weleticLoyaltyProgram.findUnique({ where: { storeId }, select }),
  );
}

/** Internal primitive: the signed gateway must authenticate and hold the store
 * lifecycle lock first. Lock order is store -> program. Never initialize or
 * activate a loyalty program through appearance, and never retry a mutation. */
export async function saveLoyaltyAppearanceInTransaction({
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
  const data = loyaltyAppearanceRequestSchema.parse(request);
  if (data.operation !== "save") throw new Error("Save required");
  if (data.expectedInstallationGeneration !== installationGeneration)
    throw new LoyaltyAppearanceConflictError();
  const locked = await lockLoyaltyProgramRowIfPresent({ tx, storeId });
  if (!locked) throw new LoyaltyAppearanceConflictError();
  const program = await tx.weleticLoyaltyProgram.findUnique({
    where: { storeId },
    select,
  });
  if (!program || program.id !== locked.id || program.storeId !== storeId)
    throw new LoyaltyAppearanceConflictError();
  assertLoyaltyMaintenanceWriteAllowed({ storeId, metadata: program.metadata });
  const current = project(storeId, program);
  const { metadata, sequence } = readMetadata(program.metadata);
  if (
    data.expectedRevision !== current.revision ||
    (current.branding.launcherPresentation !== undefined &&
      data.branding.launcherPresentation === undefined) ||
    sequence === Number.MAX_SAFE_INTEGER
  )
    throw new LoyaltyAppearanceConflictError();
  const changed = await tx.weleticLoyaltyProgram.updateMany({
    where: {
      id: program.id,
      storeId,
      updatedAt: program.updatedAt,
      branding: { equals: program.branding ?? Prisma.DbNull },
      metadata: { equals: program.metadata ?? Prisma.DbNull },
    },
    data: {
      branding: data.branding as unknown as Prisma.InputJsonObject,
      metadata: {
        ...metadata,
        loyaltyAppearanceSequence: sequence + 1,
      } as Prisma.InputJsonObject,
    },
  });
  if (changed.count !== 1) throw new LoyaltyAppearanceConflictError();
  return readLoyaltyAppearanceInTransaction(tx, storeId);
}
