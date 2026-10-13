import { z } from "zod";
import {
  CreateFlowPointsGrantSchema,
  FLOW_ABSOLUTE_DELTA_MAX,
  FLOW_UNSIGNED_MAX,
  ListFlowPointsGrantsSchema,
  RevokeFlowPointsGrantSchema,
} from "./flow-action-grant-contract";

const generation = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const id = z.string().regex(/^wflowgrant_[A-Za-z0-9_-]{20}$/);
const requestId = z.string().regex(/^[a-f0-9]{64}$/);
const quantity = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine(
    (value) =>
      /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= FLOW_UNSIGNED_MAX,
  );
export const FlowGrantViewSchema = z
  .object({
    id,
    revision: z.number().int().min(1).max(2147483647),
    allowCredit: z.boolean(),
    allowDebit: z.boolean(),
    maxAbsolutePointsPerAction: quantity,
    absolutePointsBudget: quantity,
    absolutePointsUsed: quantity,
    remainingAbsolutePoints: quantity,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
    status: z.enum(["active", "expired", "revoked", "exhausted"]),
  })
  .strict()
  .refine((row) => {
    if (
      ![
        row.maxAbsolutePointsPerAction,
        row.absolutePointsBudget,
        row.absolutePointsUsed,
        row.remainingAbsolutePoints,
      ].every((value) => /^(0|[1-9]\d{0,19})$/.test(value))
    )
      return false;
    const limit = BigInt(row.maxAbsolutePointsPerAction),
      budget = BigInt(row.absolutePointsBudget),
      used = BigInt(row.absolutePointsUsed);
    return (
      (row.allowCredit || row.allowDebit) &&
      limit > BigInt(0) &&
      limit <= FLOW_ABSOLUTE_DELTA_MAX &&
      limit <= budget &&
      used <= budget &&
      BigInt(row.remainingAbsolutePoints) === budget - used
    );
  });
export const FlowGrantListResponseSchema = z
  .object({
    grants: z.array(FlowGrantViewSchema).max(50),
    nextCursor: id.nullable(),
    installationGeneration: generation,
    observedAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (data) =>
      new Set(data.grants.map((row) => row.id)).size === data.grants.length &&
      (!data.nextCursor || data.nextCursor === data.grants.at(-1)?.id) &&
      data.grants.every(
        (row) =>
          row.status ===
          (row.revokedAt
            ? "revoked"
            : Date.parse(row.expiresAt) <= Date.parse(data.observedAt)
              ? "expired"
              : row.remainingAbsolutePoints === "0"
                ? "exhausted"
                : "active"),
      ),
  );
export const FlowGrantMutationResponseSchema = z
  .object({
    id,
    revision: z.number().int().min(1).max(2147483647),
    revokedAt: z.string().datetime().nullable(),
  })
  .strict();
// Initial list may bootstrap its generation from the authenticated actor; writes
// always carry the generation/revision previously shown to the merchant.
const listInput = z
  .object({
    ...ListFlowPointsGrantsSchema.shape,
    expectedInstallationGeneration: generation.optional(),
  })
  .strict()
  .refine(
    (input) =>
      [input.cursor, input.grantId, input.approvalRequestId].filter(Boolean)
        .length <= 1,
  );
export const FlowGrantsMerchantRequestSchema = z.discriminatedUnion(
  "operation",
  [
    z.object({ operation: z.literal("list"), input: listInput }).strict(),
    z
      .object({
        operation: z.literal("create"),
        attemptId: requestId,
        input: CreateFlowPointsGrantSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal("revoke"),
        attemptId: requestId,
        input: RevokeFlowPointsGrantSchema,
      })
      .strict(),
  ],
);
export type FlowGrantView = z.infer<typeof FlowGrantViewSchema>;
export type FlowGrantListResponse = z.infer<typeof FlowGrantListResponseSchema>;
