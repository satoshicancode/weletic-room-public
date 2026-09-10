import { z } from "zod";

export const loyaltyNudgeKinds = [
  "signup",
  "points_spending",
  "reward_usage",
] as const;
export type LoyaltyNudgeKind = (typeof loyaltyNudgeKinds)[number];
export const loyaltyNudgeLocales = ["en", "ja", "vi"] as const;
export const NUDGE_DISMISSAL_MS = 24 * 60 * 60 * 1000;

function copy(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
      "Use plain text without markup or control characters",
    );
}
const template = z
  .object({ title: copy(100), description: copy(300), actionLabel: copy(60) })
  .strict();
export const loyaltyNudgePolicySchema = z
  .object({
    kind: z.enum(loyaltyNudgeKinds),
    enabled: z.boolean(),
    icon: z.enum(["gift", "star", "award", "sparkles"]),
    templates: z.object({ en: template, ja: template, vi: template }).strict(),
  })
  .strict()
  .superRefine((policy, context) => {
    for (const locale of loyaltyNudgeLocales) {
      for (const field of ["title", "description", "actionLabel"] as const) {
        const text = policy.templates[locale][field];
        // Only spending copy has customer-dependent variables. Rendering must use
        // text nodes; this contract grants no authority to redeem or apply codes.
        const remainder =
          policy.kind === "points_spending"
            ? text.replace(/\{\{(points_label|points_balance)\}\}/g, "")
            : text;
        if (/[{}]/.test(remainder))
          context.addIssue({
            code: "custom",
            path: ["templates", locale, field],
            message: "Unsupported or malformed nudge variable",
          });
      }
    }
  });
export const loyaltyNudgeSettingsSchema = z
  .object({
    version: z.literal(1),
    policies: z.array(loyaltyNudgePolicySchema).length(3),
  })
  .strict()
  .superRefine((settings, context) => {
    if (new Set(settings.policies.map((policy) => policy.kind)).size !== 3)
      context.addIssue({
        code: "custom",
        path: ["policies"],
        message: "Each nudge must occur once",
      });
  });
export type LoyaltyNudgeSettings = z.infer<typeof loyaltyNudgeSettingsSchema>;

const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const loyaltyNudgeRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read") }).strict(),
  z
    .object({
      operation: z.literal("save"),
      expectedInstallationGeneration: z.string().min(1).max(64),
      expectedRevision: revision,
      settings: loyaltyNudgeSettingsSchema,
    })
    .strict(),
]);
export const loyaltyNudgeResponseSchema = z
  .object({
    storeId: z.string().min(1),
    installationGeneration: z.string().min(1).max(64),
    revision,
    programConfigured: z.boolean(),
    settings: loyaltyNudgeSettingsSchema,
    capabilities: z.object({ configure: z.boolean() }).strict(),
  })
  .strict();
export type LoyaltyNudgeRequest = z.infer<typeof loyaltyNudgeRequestSchema>;
export type LoyaltyNudgeResponse = z.infer<typeof loyaltyNudgeResponseSchema>;
export function verifyLoyaltyNudgeResponse(
  request: LoyaltyNudgeRequest,
  value: unknown,
): LoyaltyNudgeResponse {
  const result = loyaltyNudgeResponseSchema.parse(value);
  if (
    request.operation === "save" &&
    (result.installationGeneration !== request.expectedInstallationGeneration ||
      result.revision === request.expectedRevision ||
      !result.programConfigured ||
      !result.capabilities.configure ||
      JSON.stringify(result.settings) !==
        JSON.stringify(loyaltyNudgeSettingsSchema.parse(request.settings)))
  )
    throw new Error("Nudge acknowledgement unavailable");
  return result;
}

const defaults = {
  signup: {
    en: [
      "Join Weletic Rewards",
      "Sign in or create an account to start earning rewards.",
      "Join or sign in",
    ],
    ja: [
      "Weletic Rewardsに参加",
      "ログインまたはアカウントを作成して、ポイントを貯めましょう。",
      "登録・ログイン",
    ],
    vi: [
      "Tham gia Weletic Rewards",
      "Đăng nhập hoặc tạo tài khoản để bắt đầu tích điểm.",
      "Tham gia hoặc đăng nhập",
    ],
  },
  points_spending: {
    en: [
      "Use your {{points_label}}",
      "You have {{points_balance}} points. View rewards available to you.",
      "View rewards",
    ],
    ja: [
      "{{points_label}}を使いましょう",
      "{{points_balance}}ポイントあります。交換できる特典を確認しましょう。",
      "特典を見る",
    ],
    vi: [
      "Sử dụng {{points_label}}",
      "Bạn có {{points_balance}} điểm. Xem phần thưởng có thể đổi.",
      "Xem phần thưởng",
    ],
  },
  reward_usage: {
    en: [
      "A reward is waiting",
      "View your available reward before checking out.",
      "View reward",
    ],
    ja: [
      "利用できる特典があります",
      "購入手続きの前に特典を確認しましょう。",
      "特典を見る",
    ],
    vi: [
      "Bạn có phần thưởng",
      "Xem phần thưởng khả dụng trước khi thanh toán.",
      "Xem phần thưởng",
    ],
  },
} as const;

export function defaultLoyaltyNudgeSettings(): LoyaltyNudgeSettings {
  return loyaltyNudgeSettingsSchema.parse({
    version: 1,
    policies: loyaltyNudgeKinds.map((kind) => ({
      kind,
      enabled: false,
      icon: "gift",
      templates: Object.fromEntries(
        loyaltyNudgeLocales.map((locale) => {
          const [title, description, actionLabel] = defaults[kind][locale];
          return [locale, { title, description, actionLabel }];
        }),
      ),
    })),
  });
}
