import { z } from "zod";

const identifier = z.string().min(1).max(191);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const unsignedInteger = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/)
  .refine(
    (value) =>
      /^(?:0|[1-9]\d*)$/.test(value) &&
      (value.length < 16 || value <= "1000000000000000"),
  );
const tierId = z.string().regex(/^wtier_[A-Za-z0-9_-]{3,64}$/);
const campaignId = z.string().regex(/^wcamp_[A-Za-z0-9_-]{3,64}$/);
const unique = <T>(values: T[]) => new Set(values).size === values.length;

export const vipProgramPolicySchema = z
  .object({
    milestoneMode: z.enum(["amount_spent", "points_earned", "both"]),
    timeframe: z.enum(["rolling_12m", "calendar_year", "lifetime"]),
    downgradeGraceDays: z.number().int().min(0).max(3650),
    autoDowngradeEnabled: z.boolean(),
  })
  .strict();

export const vipTierFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    tierOrder: z.number().int().min(1).max(100),
    minSpendThreshold: unsignedInteger,
    minPointsThreshold: unsignedInteger,
    pointsMultiplier: z.number().min(1).max(100),
    entryBonusPoints: unsignedInteger,
    gracePeriodDays: z.number().int().min(0).max(3650).nullable(),
    perks: z
      .array(z.string().trim().min(1).max(120))
      .max(20)
      .refine(unique, "Duplicate perks"),
    iconUrl: z.string().url().startsWith("https://").max(2048).nullable(),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .nullable(),
  })
  .strict();

export const bonusCampaignFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable(),
    multiplier: z.number().min(1.5).max(10),
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }),
    isActive: z.boolean(),
    eligibleTierIds: z
      .array(tierId)
      .max(100)
      .refine(unique, "Duplicate tier identifiers"),
    eligibleSkus: z
      .array(
        z
          .string()
          .min(1)
          .max(255)
          .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
      )
      .max(100)
      .refine(unique, "Duplicate SKUs"),
    eligibleCollectionIds: z
      .array(z.string().regex(/^gid:\/\/shopify\/Collection\/[1-9]\d*$/))
      .max(100)
      .refine(unique, "Duplicate collection identifiers"),
  })
  .strict()
  .refine((campaign) => new Date(campaign.endAt) > new Date(campaign.startAt), {
    path: ["endAt"],
    message: "Campaign end must be after its start",
  })
  .refine(
    (campaign) =>
      new Date(campaign.endAt).getTime() -
        new Date(campaign.startAt).getTime() <=
      31 * 24 * 60 * 60 * 1000,
    { path: ["endAt"], message: "Campaigns can run for at most 31 days" },
  );

const fence = z
  .object({
    expectedInstallationGeneration: z.string().min(1).max(64),
    expectedRevision: revision,
  })
  .strict();

export const vipCampaignRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read") }).strict(),
  z
    .object({
      operation: z.literal("save_policy"),
      input: fence.extend({ policy: vipProgramPolicySchema }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("save_tier"),
      input: fence
        .extend({ tierId: tierId.nullable(), tier: vipTierFieldsSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("retire_tier"),
      input: fence.extend({ tierId }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("save_campaign"),
      input: fence
        .extend({
          campaignId: campaignId.nullable(),
          campaign: bonusCampaignFieldsSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("retire_campaign"),
      input: fence.extend({ campaignId }).strict(),
    })
    .strict(),
]);

const tierView = z.object({ id: tierId, fields: vipTierFieldsSchema }).strict();
const campaignView = z
  .object({
    id: campaignId,
    fields: bonusCampaignFieldsSchema,
    lifecycle: z.enum(["scheduled", "running", "ended", "paused"]),
    economicsEditable: z.boolean(),
  })
  .strict();

export const vipCampaignResponseSchema = z
  .object({
    storeId: identifier,
    installationGeneration: z.string().min(1).max(64),
    revision,
    affectedResourceId: identifier.nullable(),
    capabilities: z.object({ configure: z.boolean() }).strict(),
    policy: vipProgramPolicySchema,
    tiers: z.array(tierView),
    campaigns: z.array(campaignView),
    tierHistory: z.array(
      z
        .object({
          id: identifier,
          fromTierId: tierId.nullable(),
          fromTierName: z.string().min(1).max(80).nullable(),
          toTierId: tierId.nullable(),
          toTierName: z.string().min(1).max(80).nullable(),
          changeReason: z.string().min(1).max(64),
          effectiveAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();

export type VipProgramPolicy = z.infer<typeof vipProgramPolicySchema>;
export type VipTierFields = z.infer<typeof vipTierFieldsSchema>;
export type BonusCampaignFields = z.infer<typeof bonusCampaignFieldsSchema>;
export type VipCampaignRequest = z.infer<typeof vipCampaignRequestSchema>;
export type VipCampaignResponse = z.infer<typeof vipCampaignResponseSchema>;
export type VipCampaignMutation = Exclude<
  VipCampaignRequest,
  { operation: "read" }
>["input"];
