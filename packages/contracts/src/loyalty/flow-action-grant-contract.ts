import { z } from "zod";

export const FLOW_UNSIGNED_MAX = BigInt("18446744073709551615");
export const FLOW_ABSOLUTE_DELTA_MAX = BigInt("9223372036854775808");

const positiveBound = (max: bigint) =>
  z
    .string()
    .max(20)
    .refine(
      (value) => /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= max,
      "An exact positive bounded integer string is required",
    );
const grantId = z.string().regex(/^wflowgrant_[A-Za-z0-9_-]{20}$/);
const revision = z.number().int().min(1).max(2_147_483_647);
const generation = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** Merchant fields only; current store, app, owner and generation come from the
 * authenticated gateway envelope. New grants require explicit bounded authority.
 */
export const CreateFlowPointsGrantSchema = z
  .object({
    allowCredit: z.boolean(),
    allowDebit: z.boolean(),
    maxAbsolutePointsPerAction: positiveBound(FLOW_ABSOLUTE_DELTA_MAX),
    absolutePointsBudget: positiveBound(FLOW_UNSIGNED_MAX),
    expiresAt: z.string().datetime({ offset: true }),
    expectedRevision: z.literal(0),
    expectedInstallationGeneration: generation,
  })
  .strict()
  .refine(
    (value) => value.allowCredit || value.allowDebit,
    "Select at least one permitted direction",
  )
  .refine((value) => {
    if (
      !/^[1-9]\d{0,19}$/.test(value.absolutePointsBudget) ||
      !/^[1-9]\d{0,19}$/.test(value.maxAbsolutePointsPerAction)
    )
      return false;
    return (
      BigInt(value.absolutePointsBudget) >=
      BigInt(value.maxAbsolutePointsPerAction)
    );
  }, "The budget must cover the per-action limit");

export const RevokeFlowPointsGrantSchema = z
  .object({
    grantId,
    expectedRevision: revision,
    expectedInstallationGeneration: generation,
  })
  .strict();

export const ListFlowPointsGrantsSchema = z
  .object({
    expectedInstallationGeneration: generation,
    cursor: grantId.optional(),
    grantId: grantId.optional(),
    limit: z.number().int().min(1).max(50).default(20),
    approvalRequestId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine(
    (input) =>
      [input.cursor, input.grantId, input.approvalRequestId].filter(Boolean)
        .length <= 1,
    "Use one pagination or recovery selector",
  );

/** Arithmetic only, not authorization. The writer supplies locked persisted
 * values after store/grant/privacy checks and rechecks fresh database-time expiry.
 */
export function consumeFlowPointsBudget(input: {
  pointsDelta: bigint;
  allowCredit: boolean;
  allowDebit: boolean;
  maxAbsolutePointsPerAction: bigint;
  absolutePointsBudget: bigint;
  absolutePointsUsed: bigint;
}) {
  const amount =
    input.pointsDelta < BigInt(0) ? -input.pointsDelta : input.pointsDelta;
  if (
    input.pointsDelta === BigInt(0) ||
    input.pointsDelta < -FLOW_ABSOLUTE_DELTA_MAX ||
    input.pointsDelta >= FLOW_ABSOLUTE_DELTA_MAX ||
    (input.pointsDelta > BigInt(0) ? !input.allowCredit : !input.allowDebit) ||
    input.maxAbsolutePointsPerAction <= BigInt(0) ||
    input.maxAbsolutePointsPerAction > FLOW_ABSOLUTE_DELTA_MAX ||
    input.absolutePointsBudget <= BigInt(0) ||
    input.absolutePointsBudget > FLOW_UNSIGNED_MAX ||
    input.absolutePointsUsed < BigInt(0) ||
    input.absolutePointsUsed > input.absolutePointsBudget ||
    amount > input.maxAbsolutePointsPerAction ||
    amount > input.absolutePointsBudget - input.absolutePointsUsed
  )
    throw new Error("Flow points grant limit exceeded");
  return input.absolutePointsUsed + amount;
}
