import { createWeleticId } from "@/lib/weletic/ids";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  loyaltyCommunicationPolicySchema,
  loyaltyCommunicationsRequestSchema,
} from "./communications-contract";
import { lockLoyaltyProgramRowIfPresent } from "./program-write-fence";

const storageSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    policies: z.array(loyaltyCommunicationPolicySchema).max(9),
  })
  .strict()
  .refine(
    ({ policies }) =>
      new Set(policies.map((policy) => policy.journey)).size ===
      policies.length,
  );

export class LoyaltyCommunicationsConflictError extends Error {
  constructor() {
    super("Loyalty communications state changed");
    this.name = "LoyaltyCommunicationsConflictError";
  }
}

function decodeMetadata(value: Prisma.JsonValue | null) {
  if (value !== null && (typeof value !== "object" || Array.isArray(value)))
    throw new Error("Invalid loyalty program metadata");
  const metadata = value ?? {};
  const stored = Object.prototype.hasOwnProperty.call(
    metadata,
    "loyaltyCommunications",
  )
    ? storageSchema.parse(metadata.loyaltyCommunications)
    : storageSchema.parse({ version: 1, sequence: 0, policies: [] });
  return { metadata, stored };
}

function project(
  storeId: string,
  programId: string | null,
  stored: z.infer<typeof storageSchema>,
) {
  const policies = [...stored.policies].sort((a, b) =>
    a.journey.localeCompare(b.journey),
  );
  const revision = createHash("sha256")
    .update(JSON.stringify({ storeId, programId, ...stored, policies }))
    .digest("hex");
  return { revision, policies };
}

/** Immutable policy selection for an event producer already holding the store
 * and program locks. No customer data, recipient, URL or sender is captured. */
export function snapshotLoyaltyCommunicationPolicy({
  storeId,
  programId,
  metadata,
  journey,
}: {
  storeId: string;
  programId: string;
  metadata: Prisma.JsonValue | null;
  journey:
    | "points_warning"
    | "points_last_chance"
    | "points_earned"
    | "birthday"
    | "reward_redeemed"
    | "referral_friend"
    | "referral_advocate"
    | "vip_achieved";
}) {
  const state = project(storeId, programId, decodeMetadata(metadata).stored);
  const policy = state.policies.find(
    (candidate) => candidate.journey === journey,
  );
  return policy
    ? {
        version: 1 as const,
        storeId,
        programId,
        revision: state.revision,
        policy,
      }
    : null;
}

export async function readLoyaltyCommunicationsInTransaction(
  tx: Prisma.TransactionClient,
  storeId: string,
) {
  const program = await tx.weleticLoyaltyProgram.findUnique({
    where: { storeId },
    select: { id: true, metadata: true },
  });
  return project(
    storeId,
    program?.id ?? null,
    decodeMetadata(program?.metadata ?? null).stored,
  );
}

/** Caller must hold the authenticated store/session lifecycle lock. Lock order
 * is store -> program. Saving configuration never queues or sends a message. */
export async function saveLoyaltyCommunicationsInTransaction({
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
  const data = loyaltyCommunicationsRequestSchema.parse(request);
  if (data.operation !== "save") throw new Error("Save required");
  if (data.expectedInstallationGeneration !== installationGeneration)
    throw new LoyaltyCommunicationsConflictError();
  const program = await lockLoyaltyProgramRowIfPresent({ tx, storeId });
  const { metadata, stored } = decodeMetadata(program?.metadata ?? null);
  const current = project(storeId, program?.id ?? null, stored);
  if (
    data.expectedRevision !== current.revision ||
    stored.sequence === Number.MAX_SAFE_INTEGER
  )
    throw new LoyaltyCommunicationsConflictError();
  const next = storageSchema.parse({
    version: 1,
    sequence: stored.sequence + 1,
    policies: [
      ...stored.policies.filter(
        (policy) => policy.journey !== data.policy.journey,
      ),
      data.policy,
    ],
  });
  const nextMetadata = {
    ...metadata,
    loyaltyCommunications: next,
  } as Prisma.InputJsonObject;
  const id = program?.id ?? createWeleticId("wprog_");
  if (program) {
    const changed = await tx.weleticLoyaltyProgram.updateMany({
      where: {
        id,
        storeId,
        metadata: { equals: program.metadata ?? Prisma.DbNull },
      },
      data: { metadata: nextMetadata },
    });
    if (changed.count !== 1) throw new LoyaltyCommunicationsConflictError();
  } else {
    await tx.weleticLoyaltyProgram.create({
      data: {
        id,
        storeId,
        name: "Customer Loyalty Program",
        status: "draft",
        metadata: nextMetadata,
      },
    });
  }
  return project(storeId, id, next);
}
