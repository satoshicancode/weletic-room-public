import { z } from "zod";

export const loyaltyCommunicationJourneySchema = z.enum([
  "points_earned",
  "reward_redeemed",
  "referral_friend",
  "referral_advocate",
  "birthday",
  "vip_achieved",
  "reward_expiry",
  "points_warning",
  "points_last_chance",
]);
export type LoyaltyCommunicationJourney = z.infer<
  typeof loyaltyCommunicationJourneySchema
>;

const commonVariables = ["brand_name", "customer_first_name"] as const;
export const loyaltyCommunicationVariables = {
  points_earned: [...commonVariables, "points", "points_label", "reward_name"],
  reward_redeemed: [...commonVariables, "reward_name", "reward_value"],
  referral_friend: [...commonVariables, "reward_name", "reward_value"],
  referral_advocate: [
    ...commonVariables,
    "reward_name",
    "points",
    "points_label",
  ],
  birthday: [...commonVariables, "reward_name", "points", "points_label"],
  vip_achieved: [...commonVariables, "tier_name"],
  reward_expiry: [...commonVariables, "reward_name", "expiry_date"],
  points_warning: [...commonVariables, "points", "points_label", "expiry_date"],
  points_last_chance: [
    ...commonVariables,
    "points",
    "points_label",
    "expiry_date",
  ],
} satisfies Record<LoyaltyCommunicationJourney, readonly string[]>;

// Templates are plain text. No Liquid, expressions, HTML or recipient/link fields.
// Renderers must use text nodes; this function does not produce trusted HTML.
const tokenPattern = /\{\{\s*([a-z_]+)\s*\}\}/g;
function templateVariables(text: string) {
  const names = Array.from(text.matchAll(tokenPattern), (match) => match[1]);
  if (/[{}]/.test(text.replace(tokenPattern, "")))
    throw new Error("Invalid communication variable syntax");
  return names;
}
const textField = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !/[<>\u0000-\u0008\u000b-\u001f\u007f]/.test(text), {
      message: "Plain text is required",
    });
const singleLine = (max: number) =>
  textField(max).refine((text) => !/[\r\n]/.test(text), {
    message: "A single line is required",
  });
export const loyaltyCommunicationTemplateSchema = z
  .object({
    subject: singleLine(200),
    heading: singleLine(200),
    body: textField(5000),
    actionLabel: singleLine(80),
  })
  .strict();

export const loyaltyCommunicationPolicySchema = z
  .object({
    journey: loyaltyCommunicationJourneySchema,
    enabled: z.boolean(),
    templates: z
      .object({
        en: loyaltyCommunicationTemplateSchema,
        ja: loyaltyCommunicationTemplateSchema,
        vi: loyaltyCommunicationTemplateSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((policy, context) => {
    const allowed: readonly string[] =
      loyaltyCommunicationVariables[policy.journey];
    for (const [locale, template] of Object.entries(policy.templates)) {
      for (const [field, text] of Object.entries(template)) {
        try {
          if (templateVariables(text).some((name) => !allowed.includes(name)))
            throw new Error("Variable is unavailable for this journey");
        } catch {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["templates", locale, field],
            message: "Invalid or unavailable communication variable",
          });
        }
      }
    }
  });

export const loyaltyExpiryCommunicationSnapshotSchema = z
  .object({
    version: z.literal(1),
    storeId: z.string().min(1),
    programId: z.string().min(1),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    policy: loyaltyCommunicationPolicySchema.refine(
      (policy) =>
        policy.journey === "points_warning" ||
        policy.journey === "points_last_chance",
    ),
  })
  .strict();

export const loyaltyCommunicationsRequestSchema = z.discriminatedUnion(
  "operation",
  [
    z.object({ operation: z.literal("read") }).strict(),
    z
      .object({
        operation: z.literal("save"),
        expectedInstallationGeneration: z.string().min(1).max(64),
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
        policy: loyaltyCommunicationPolicySchema,
      })
      .strict(),
  ],
);

/** Exact string substitution only, with no recursive interpolation. Missing
 * event data fails closed instead of sending unresolved placeholders. */
export function renderLoyaltyCommunicationText(
  text: string,
  journey: LoyaltyCommunicationJourney,
  values: Readonly<Record<string, string>>,
) {
  const allowed: readonly string[] = loyaltyCommunicationVariables[journey];
  const names = templateVariables(text);
  for (const name of names) {
    if (
      !allowed.includes(name) ||
      !Object.prototype.hasOwnProperty.call(values, name)
    )
      throw new Error("Communication variable unavailable");
    // Prevent event data from introducing subject/header control characters.
    if (
      typeof values[name] !== "string" ||
      /[\u0000-\u001f\u007f]/.test(values[name])
    )
      throw new Error("Invalid communication variable value");
  }
  return text.replace(tokenPattern, (_match, name: string) => values[name]);
}

export const loyaltyCommunicationsResponseSchema = z
  .object({
    storeId: z.string().min(1).max(191),
    installationGeneration: z.string().min(1).max(64),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    capabilities: z.object({ configure: z.boolean() }).strict(),
    // Configuration availability is not evidence of an integrated producer.
    deliveryIntegration: z.enum([
      "not_connected",
      "expiry_policies",
      "purchase_and_expiry_policies",
    ]),
    policies: z.array(loyaltyCommunicationPolicySchema).max(9),
  })
  .strict()
  .refine(
    ({ policies }) =>
      new Set(policies.map((policy) => policy.journey)).size ===
      policies.length,
  );

export type LoyaltyCommunicationsRequest = z.infer<
  typeof loyaltyCommunicationsRequestSchema
>;
export type LoyaltyCommunicationsResponse = z.infer<
  typeof loyaltyCommunicationsResponseSchema
>;

export function verifyLoyaltyCommunicationsResponse(
  request: LoyaltyCommunicationsRequest,
  value: unknown,
) {
  const result = loyaltyCommunicationsResponseSchema.parse(value);
  if (request.operation === "save") {
    const saved = result.policies.find(
      (policy) => policy.journey === request.policy.journey,
    );
    if (
      !result.capabilities.configure ||
      result.installationGeneration !==
        request.expectedInstallationGeneration ||
      result.revision === request.expectedRevision ||
      JSON.stringify(saved) !==
        JSON.stringify(loyaltyCommunicationPolicySchema.parse(request.policy))
    )
      throw new Error("Communications acknowledgement mismatch");
  }
  return result;
}
