// apps/web/lib/types/enums.ts
// Auto-generated SQLite/D1 compatible enum definitions and @prisma/client module augmentation.
// Generated for Cloudflare D1 migration (R1).

export const BountyPerformanceScope = {
  new: "new",
  lifetime: "lifetime",
} as const;
export type BountyPerformanceScope = (typeof BountyPerformanceScope)[keyof typeof BountyPerformanceScope];

export const BountyStartMode = {
  absolute: "absolute",
  relative: "relative",
} as const;
export type BountyStartMode = (typeof BountyStartMode)[keyof typeof BountyStartMode];

export const BountySubmissionFrequency = {
  day: "day",
  week: "week",
  month: "month",
} as const;
export type BountySubmissionFrequency = (typeof BountySubmissionFrequency)[keyof typeof BountySubmissionFrequency];

export const BountySubmissionRejectionReason = {
  invalidProof: "invalidProof",
  duplicateSubmission: "duplicateSubmission",
  outOfTimeWindow: "outOfTimeWindow",
  didNotMeetCriteria: "didNotMeetCriteria",
  other: "other",
} as const;
export type BountySubmissionRejectionReason = (typeof BountySubmissionRejectionReason)[keyof typeof BountySubmissionRejectionReason];

export const BountySubmissionStatus = {
  draft: "draft",
  submitted: "submitted",
  approved: "approved",
  rejected: "rejected",
} as const;
export type BountySubmissionStatus = (typeof BountySubmissionStatus)[keyof typeof BountySubmissionStatus];

export const BountyType = {
  performance: "performance",
  submission: "submission",
} as const;
export type BountyType = (typeof BountyType)[keyof typeof BountyType];

export const CampaignStatus = {
  draft: "draft",
  active: "active",
  paused: "paused",
  scheduled: "scheduled",
  sending: "sending",
  sent: "sent",
  canceled: "canceled",
} as const;
export type CampaignStatus = (typeof CampaignStatus)[keyof typeof CampaignStatus];

export const CampaignType = {
  marketing: "marketing",
  transactional: "transactional",
} as const;
export type CampaignType = (typeof CampaignType)[keyof typeof CampaignType];

export const Category = {
  AI: "AI",
  Development: "Development",
  Design: "Design",
  Productivity: "Productivity",
  Finance: "Finance",
  Marketing: "Marketing",
  Ecommerce: "Ecommerce",
  Security: "Security",
  Education: "Education",
  Health: "Health",
  Consumer: "Consumer",
  Support: "Support",
} as const;
export type Category = (typeof Category)[keyof typeof Category];

export const CommissionStatus = {
  pending: "pending",
  processed: "processed",
  paid: "paid",
  refunded: "refunded",
  duplicate: "duplicate",
  fraud: "fraud",
  canceled: "canceled",
  hold: "hold",
} as const;
export type CommissionStatus = (typeof CommissionStatus)[keyof typeof CommissionStatus];

export const CommissionType = {
  click: "click",
  lead: "lead",
  sale: "sale",
  referral: "referral",
  custom: "custom",
} as const;
export type CommissionType = (typeof CommissionType)[keyof typeof CommissionType];

export const DiscountProvider = {
  stripe: "stripe",
  shopify: "shopify",
} as const;
export type DiscountProvider = (typeof DiscountProvider)[keyof typeof DiscountProvider];

export const DubProduct = {
  program: "program",
  links: "links",
} as const;
export type DubProduct = (typeof DubProduct)[keyof typeof DubProduct];

export const EmailDomainStatus = {
  pending: "pending",
  verified: "verified",
  failed: "failed",
  temporary_failure: "temporary_failure",
  not_started: "not_started",
} as const;
export type EmailDomainStatus = (typeof EmailDomainStatus)[keyof typeof EmailDomainStatus];

export const EventType = {
  click: "click",
  lead: "lead",
  sale: "sale",
  referral: "referral",
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

export const FolderAccessLevel = {
  read: "read",
  write: "write",
} as const;
export type FolderAccessLevel = (typeof FolderAccessLevel)[keyof typeof FolderAccessLevel];

export const FolderType = {
  default: "default",
  mega: "mega",
} as const;
export type FolderType = (typeof FolderType)[keyof typeof FolderType];

export const FolderUserRole = {
  owner: "owner",
  editor: "editor",
  viewer: "viewer",
} as const;
export type FolderUserRole = (typeof FolderUserRole)[keyof typeof FolderUserRole];

export const FraudAlertStatus = {
  pending: "pending",
  confirmed: "confirmed",
  dismissed: "dismissed",
} as const;
export type FraudAlertStatus = (typeof FraudAlertStatus)[keyof typeof FraudAlertStatus];

export const FraudEventStatus = {
  pending: "pending",
  resolved: "resolved",
  expired: "expired",
} as const;
export type FraudEventStatus = (typeof FraudEventStatus)[keyof typeof FraudEventStatus];

export const FraudRuleType = {
  customerEmailMatch: "customerEmailMatch",
  customerEmailSuspiciousDomain: "customerEmailSuspiciousDomain",
  referralSourceBanned: "referralSourceBanned",
  paidTrafficDetected: "paidTrafficDetected",
  partnerCrossProgramBan: "partnerCrossProgramBan",
  partnerDuplicateAccount: "partnerDuplicateAccount",
} as const;
export type FraudRuleType = (typeof FraudRuleType)[keyof typeof FraudRuleType];

export const IdentityVerificationStatus = {
  started: "started",
  submitted: "submitted",
  approved: "approved",
  declined: "declined",
  resubmissionRequested: "resubmissionRequested",
  expired: "expired",
  abandoned: "abandoned",
  review: "review",
} as const;
export type IdentityVerificationStatus = (typeof IdentityVerificationStatus)[keyof typeof IdentityVerificationStatus];

export const IndustryInterest = {
  SaaS: "SaaS",
  DevTool: "DevTool",
  AI: "AI",
  Creative_And_Design: "Creative_And_Design",
  Productivity_Software: "Productivity_Software",
  Marketing: "Marketing",
  Gaming: "Gaming",
  Finance: "Finance",
  Sales: "Sales",
  Ecommerce: "Ecommerce",
  Customer_Service_And_Support: "Customer_Service_And_Support",
  Content_Management: "Content_Management",
  Human_Resources: "Human_Resources",
  Security: "Security",
  Analytics_And_Data: "Analytics_And_Data",
  Social_Media: "Social_Media",
  Consumer_Tech: "Consumer_Tech",
  Education_And_Learning: "Education_And_Learning",
  Health_And_Fitness: "Health_And_Fitness",
  Food_And_Beverage: "Food_And_Beverage",
  Travel_And_Lifestyle: "Travel_And_Lifestyle",
  Entertainment_And_Media: "Entertainment_And_Media",
  Sports: "Sports",
  Science_And_Engineering: "Science_And_Engineering",
} as const;
export type IndustryInterest = (typeof IndustryInterest)[keyof typeof IndustryInterest];

export const InvoiceStatus = {
  processing: "processing",
  completed: "completed",
  failed: "failed",
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

export const InvoiceType = {
  partnerPayout: "partnerPayout",
  domainRenewal: "domainRenewal",
} as const;
export type InvoiceType = (typeof InvoiceType)[keyof typeof InvoiceType];

export const LinkScope = {
  workspace: "workspace",
  folders: "folders",
  links: "links",
} as const;
export type LinkScope = (typeof LinkScope)[keyof typeof LinkScope];

export const MessageType = {
  direct: "direct",
  campaign: "campaign",
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const MonthlyTraffic = {
  ZeroToOneThousand: "ZeroToOneThousand",
  OneThousandToTenThousand: "OneThousandToTenThousand",
  TenThousandToFiftyThousand: "TenThousandToFiftyThousand",
  FiftyThousandToOneHundredThousand: "FiftyThousandToOneHundredThousand",
  OneHundredThousandPlus: "OneHundredThousandPlus",
} as const;
export type MonthlyTraffic = (typeof MonthlyTraffic)[keyof typeof MonthlyTraffic];

export const NotificationEmailType = {
  Message: "Message",
  Bounty: "Bounty",
  Campaign: "Campaign",
} as const;
export type NotificationEmailType = (typeof NotificationEmailType)[keyof typeof NotificationEmailType];

export const PartnerBannedReason = {
  tos_violation: "tos_violation",
  inappropriate_content: "inappropriate_content",
  fake_traffic: "fake_traffic",
  fraud: "fraud",
  spam: "spam",
  brand_abuse: "brand_abuse",
} as const;
export type PartnerBannedReason = (typeof PartnerBannedReason)[keyof typeof PartnerBannedReason];

export const PartnerLinkStructure = {
  short: "short",
  query: "query",
  path: "path",
} as const;
export type PartnerLinkStructure = (typeof PartnerLinkStructure)[keyof typeof PartnerLinkStructure];

export const PartnerNetworkStatus = {
  draft: "draft",
  submitted: "submitted",
  approved: "approved",
  rejected: "rejected",
  trusted: "trusted",
} as const;
export type PartnerNetworkStatus = (typeof PartnerNetworkStatus)[keyof typeof PartnerNetworkStatus];

export const PartnerPayoutMethod = {
  connect: "connect",
  stablecoin: "stablecoin",
  paypal: "paypal",
  tremendous: "tremendous",
} as const;
export type PartnerPayoutMethod = (typeof PartnerPayoutMethod)[keyof typeof PartnerPayoutMethod];

export const PartnerProfileType = {
  individual: "individual",
  company: "company",
} as const;
export type PartnerProfileType = (typeof PartnerProfileType)[keyof typeof PartnerProfileType];

export const PartnerRole = {
  owner: "owner",
  member: "member",
} as const;
export type PartnerRole = (typeof PartnerRole)[keyof typeof PartnerRole];

export const PaymentMethod = {
  card: "card",
  ach: "ach",
  ach_fast: "ach_fast",
  sepa: "sepa",
  acss: "acss",
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const PayoutMode = {
  internal: "internal",
  external: "external",
} as const;
export type PayoutMode = (typeof PayoutMode)[keyof typeof PayoutMode];

export const PayoutStatus = {
  pending: "pending",
  processing: "processing",
  processed: "processed",
  sent: "sent",
  completed: "completed",
  failed: "failed",
  canceled: "canceled",
} as const;
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

export const PlanPeriod = {
  monthly: "monthly",
  yearly: "yearly",
  quarterly: "quarterly",
  biweekly: "biweekly",
} as const;
export type PlanPeriod = (typeof PlanPeriod)[keyof typeof PlanPeriod];

export const PlatformType = {
  website: "website",
  youtube: "youtube",
  twitter: "twitter",
  linkedin: "linkedin",
  instagram: "instagram",
  tiktok: "tiktok",
} as const;
export type PlatformType = (typeof PlatformType)[keyof typeof PlatformType];

export const PostbackReceiver = {
  custom: "custom",
  slack: "slack",
} as const;
export type PostbackReceiver = (typeof PostbackReceiver)[keyof typeof PostbackReceiver];

export const PreferredEarningStructure = {
  Revenue_Share: "Revenue_Share",
  Per_Lead: "Per_Lead",
  Per_Sale: "Per_Sale",
  Per_Click: "Per_Click",
  One_Time_Payment: "One_Time_Payment",
} as const;
export type PreferredEarningStructure = (typeof PreferredEarningStructure)[keyof typeof PreferredEarningStructure];

export const ProgramApplicationRejectionReason = {
  needsMoreDetail: "needsMoreDetail",
  doesNotMeetRequirements: "doesNotMeetRequirements",
  notTheRightFit: "notTheRightFit",
  other: "other",
} as const;
export type ProgramApplicationRejectionReason = (typeof ProgramApplicationRejectionReason)[keyof typeof ProgramApplicationRejectionReason];

export const ProgramEnrollmentStatus = {
  pending: "pending",
  approved: "approved",
  rejected: "rejected",
  invited: "invited",
  declined: "declined",
  deactivated: "deactivated",
  banned: "banned",
  archived: "archived",
} as const;
export type ProgramEnrollmentStatus = (typeof ProgramEnrollmentStatus)[keyof typeof ProgramEnrollmentStatus];

export const ProgramPayoutMode = {
  internal: "internal",
  hybrid: "hybrid",
  external: "external",
} as const;
export type ProgramPayoutMode = (typeof ProgramPayoutMode)[keyof typeof ProgramPayoutMode];

export const ReapplicationTimeframe = {
  instant: "instant",
  standard: "standard",
  never: "never",
} as const;
export type ReapplicationTimeframe = (typeof ReapplicationTimeframe)[keyof typeof ReapplicationTimeframe];

export const RewardSpendLimitInterval = {
  allTime: "allTime",
  day: "day",
  week: "week",
  month: "month",
} as const;
export type RewardSpendLimitInterval = (typeof RewardSpendLimitInterval)[keyof typeof RewardSpendLimitInterval];

export const RewardStructure = {
  percentage: "percentage",
  flat: "flat",
} as const;
export type RewardStructure = (typeof RewardStructure)[keyof typeof RewardStructure];

export const SalesChannel = {
  Blogs: "Blogs",
  Coupons: "Coupons",
  Direct_Reselling: "Direct_Reselling",
  Newsletters: "Newsletters",
  Social_Media: "Social_Media",
  Events: "Events",
  Company_Referrals: "Company_Referrals",
} as const;
export type SalesChannel = (typeof SalesChannel)[keyof typeof SalesChannel];

export const SubmittedLeadStatus = {
  pending: "pending",
  qualified: "qualified",
  meeting: "meeting",
  negotiation: "negotiation",
  unqualified: "unqualified",
  closedWon: "closedWon",
  closedLost: "closedLost",
} as const;
export type SubmittedLeadStatus = (typeof SubmittedLeadStatus)[keyof typeof SubmittedLeadStatus];

export const WebhookReceiver = {
  user: "user",
  zapier: "zapier",
  make: "make",
  slack: "slack",
  segment: "segment",
} as const;
export type WebhookReceiver = (typeof WebhookReceiver)[keyof typeof WebhookReceiver];

export const WeleticCommissionRuleType = {
  percentage: "percentage",
  fixed: "fixed",
} as const;
export type WeleticCommissionRuleType = (typeof WeleticCommissionRuleType)[keyof typeof WeleticCommissionRuleType];

export const WeleticCommissionScope = {
  program: "program",
  partner: "partner",
  collection: "collection",
  product: "product",
  variant: "variant",
  promotion: "promotion",
  tag: "tag",
} as const;
export type WeleticCommissionScope = (typeof WeleticCommissionScope)[keyof typeof WeleticCommissionScope];

export const WeleticComplianceRequestStatus = {
  pending: "pending",
  processing: "processing",
  retrying: "retrying",
  completed: "completed",
  dead_letter: "dead_letter",
} as const;
export type WeleticComplianceRequestStatus = (typeof WeleticComplianceRequestStatus)[keyof typeof WeleticComplianceRequestStatus];

export const WeleticComplianceRequestType = {
  customer_data_request: "customer_data_request",
  customer_redact: "customer_redact",
  shop_redact: "shop_redact",
  app_uninstalled: "app_uninstalled",
} as const;
export type WeleticComplianceRequestType = (typeof WeleticComplianceRequestType)[keyof typeof WeleticComplianceRequestType];

export const WeleticCustomerClassification = {
  new: "new",
  returning: "returning",
  unknown: "unknown",
} as const;
export type WeleticCustomerClassification = (typeof WeleticCustomerClassification)[keyof typeof WeleticCustomerClassification];

export const WeleticCustomerPrivacyIdentityKind = {
  customer_id: "customer_id",
  customer_email: "customer_email",
} as const;
export type WeleticCustomerPrivacyIdentityKind = (typeof WeleticCustomerPrivacyIdentityKind)[keyof typeof WeleticCustomerPrivacyIdentityKind];

export const WeleticEarningRuleType = {
  multiplier: "multiplier",
  fixed_points: "fixed_points",
} as const;
export type WeleticEarningRuleType = (typeof WeleticEarningRuleType)[keyof typeof WeleticEarningRuleType];

export const WeleticFixedAmountMode = {
  order: "order",
  line: "line",
  item: "item",
} as const;
export type WeleticFixedAmountMode = (typeof WeleticFixedAmountMode)[keyof typeof WeleticFixedAmountMode];

export const WeleticLedgerEntryType = {
  sale: "sale",
  reversal: "reversal",
  adjustment: "adjustment",
} as const;
export type WeleticLedgerEntryType = (typeof WeleticLedgerEntryType)[keyof typeof WeleticLedgerEntryType];

export const WeleticLoyaltyAccountStatus = {
  active: "active",
  suspended: "suspended",
  closed: "closed",
} as const;
export type WeleticLoyaltyAccountStatus = (typeof WeleticLoyaltyAccountStatus)[keyof typeof WeleticLoyaltyAccountStatus];

export const WeleticLoyaltyBackfillCreditStatus = {
  claimed: "claimed",
  credited: "credited",
} as const;
export type WeleticLoyaltyBackfillCreditStatus = (typeof WeleticLoyaltyBackfillCreditStatus)[keyof typeof WeleticLoyaltyBackfillCreditStatus];

export const WeleticLoyaltyBackfillJobStatus = {
  pending: "pending",
  calculating: "calculating",
  preview_ready: "preview_ready",
  committing: "committing",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;
export type WeleticLoyaltyBackfillJobStatus = (typeof WeleticLoyaltyBackfillJobStatus)[keyof typeof WeleticLoyaltyBackfillJobStatus];

export const WeleticLoyaltyEarnGrantStatus = {
  pending: "pending",
  settled: "settled",
  matured: "matured",
  partially_reversed: "partially_reversed",
  reversed: "reversed",
  voided: "voided",
} as const;
export type WeleticLoyaltyEarnGrantStatus = (typeof WeleticLoyaltyEarnGrantStatus)[keyof typeof WeleticLoyaltyEarnGrantStatus];

export const WeleticLoyaltyImportRowStatus = {
  pending: "pending",
  committed: "committed",
  rolled_back: "rolled_back",
  contained: "contained",
} as const;
export type WeleticLoyaltyImportRowStatus = (typeof WeleticLoyaltyImportRowStatus)[keyof typeof WeleticLoyaltyImportRowStatus];

export const WeleticLoyaltyImportStatus = {
  preview: "preview",
  committing: "committing",
  committed: "committed",
  rolling_back: "rolling_back",
  rolled_back: "rolled_back",
  contained: "contained",
  cancelled: "cancelled",
} as const;
export type WeleticLoyaltyImportStatus = (typeof WeleticLoyaltyImportStatus)[keyof typeof WeleticLoyaltyImportStatus];

export const WeleticLoyaltyOutboxJobStatus = {
  pending: "pending",
  processing: "processing",
  completed: "completed",
  failed: "failed",
  dead_letter: "dead_letter",
  cancelled: "cancelled",
} as const;
export type WeleticLoyaltyOutboxJobStatus = (typeof WeleticLoyaltyOutboxJobStatus)[keyof typeof WeleticLoyaltyOutboxJobStatus];

export const WeleticLoyaltyOutboxJobType = {
  HOLDING_PERIOD_RELEASE: "HOLDING_PERIOD_RELEASE",
  INACTIVITY_EXPIRY: "INACTIVITY_EXPIRY",
  TIER_REVIEW: "TIER_REVIEW",
  METAFIELD_SYNC: "METAFIELD_SYNC",
  REDEMPTION_RECOVERY: "REDEMPTION_RECOVERY",
  BIRTHDAY_REWARD: "BIRTHDAY_REWARD",
  REFERRAL_REWARD_PROVISION: "REFERRAL_REWARD_PROVISION",
  VOUCHER_PRIVACY_CLEANUP: "VOUCHER_PRIVACY_CLEANUP",
  REVIEW_REQUEST_EMAIL: "REVIEW_REQUEST_EMAIL",
  REVIEW_SUMMARY_SYNC: "REVIEW_SUMMARY_SYNC",
  REVIEW_MEDIA_CLEANUP: "REVIEW_MEDIA_CLEANUP",
  FLOW_TRIGGER: "FLOW_TRIGGER",
  SHOPPER_REWARD_PROVISION: "SHOPPER_REWARD_PROVISION",
  LOYALTY_COMMUNICATION: "LOYALTY_COMMUNICATION",
  HISTORICAL_IMPORT_COMMIT: "HISTORICAL_IMPORT_COMMIT",
  HISTORICAL_IMPORT_ROLLBACK: "HISTORICAL_IMPORT_ROLLBACK",
  REVIEW_POINTS_RECOVERY: "REVIEW_POINTS_RECOVERY",
  ANONYMOUS_REFERRAL_EMAIL: "ANONYMOUS_REFERRAL_EMAIL",
} as const;
export type WeleticLoyaltyOutboxJobType = (typeof WeleticLoyaltyOutboxJobType)[keyof typeof WeleticLoyaltyOutboxJobType];

export const WeleticLoyaltyReferralStatus = {
  pending: "pending",
  qualified: "qualified",
  rewarded: "rewarded",
  cancelled: "cancelled",
  fraud_blocked: "fraud_blocked",
} as const;
export type WeleticLoyaltyReferralStatus = (typeof WeleticLoyaltyReferralStatus)[keyof typeof WeleticLoyaltyReferralStatus];

export const WeleticLoyaltyStatus = {
  draft: "draft",
  test: "test",
  active: "active",
  disabled: "disabled",
} as const;
export type WeleticLoyaltyStatus = (typeof WeleticLoyaltyStatus)[keyof typeof WeleticLoyaltyStatus];

export const WeleticLoyaltyTierChangeReason = {
  threshold_reached: "threshold_reached",
  manual_override: "manual_override",
  annual_downgrade: "annual_downgrade",
  bonus_promotion: "bonus_promotion",
  grace_period_expired: "grace_period_expired",
  program_activation: "program_activation",
} as const;
export type WeleticLoyaltyTierChangeReason = (typeof WeleticLoyaltyTierChangeReason)[keyof typeof WeleticLoyaltyTierChangeReason];

export const WeleticOrderStatus = {
  pending: "pending",
  paid: "paid",
  partially_refunded: "partially_refunded",
  refunded: "refunded",
  voided: "voided",
} as const;
export type WeleticOrderStatus = (typeof WeleticOrderStatus)[keyof typeof WeleticOrderStatus];

export const WeleticPayoutProfileStatus = {
  draft: "draft",
  pending_verification: "pending_verification",
  verified: "verified",
  disabled: "disabled",
} as const;
export type WeleticPayoutProfileStatus = (typeof WeleticPayoutProfileStatus)[keyof typeof WeleticPayoutProfileStatus];

export const WeleticPointsLedgerEntryType = {
  EARN_ORDER: "EARN_ORDER",
  EARN_REFERRAL: "EARN_REFERRAL",
  EARN_BONUS: "EARN_BONUS",
  REDEEM_REWARD: "REDEEM_REWARD",
  REFUND_REVERSAL: "REFUND_REVERSAL",
  MANUAL_ADJUSTMENT: "MANUAL_ADJUSTMENT",
  EXPIRATION: "EXPIRATION",
  BACKFILL: "BACKFILL",
  BACKFILL_CORRECTION: "BACKFILL_CORRECTION",
  TIER_BONUS: "TIER_BONUS",
} as const;
export type WeleticPointsLedgerEntryType = (typeof WeleticPointsLedgerEntryType)[keyof typeof WeleticPointsLedgerEntryType];

export const WeleticProductReviewStatus = {
  pending: "pending",
  published: "published",
  hidden: "hidden",
  rejected: "rejected",
  redacted: "redacted",
} as const;
export type WeleticProductReviewStatus = (typeof WeleticProductReviewStatus)[keyof typeof WeleticProductReviewStatus];

export const WeleticProductStatus = {
  active: "active",
  draft: "draft",
  archived: "archived",
} as const;
export type WeleticProductStatus = (typeof WeleticProductStatus)[keyof typeof WeleticProductStatus];

export const WeleticReconciliationStatus = {
  open: "open",
  resolved: "resolved",
  ignored: "ignored",
} as const;
export type WeleticReconciliationStatus = (typeof WeleticReconciliationStatus)[keyof typeof WeleticReconciliationStatus];

export const WeleticRedemptionStatus = {
  active: "active",
  provisioning: "provisioning",
  issued: "issued",
  used: "used",
  failed: "failed",
  cancelled: "cancelled",
  expired: "expired",
} as const;
export type WeleticRedemptionStatus = (typeof WeleticRedemptionStatus)[keyof typeof WeleticRedemptionStatus];

export const WeleticReferralRewardKind = {
  points: "points",
  coupon: "coupon",
} as const;
export type WeleticReferralRewardKind = (typeof WeleticReferralRewardKind)[keyof typeof WeleticReferralRewardKind];

export const WeleticReviewMediaStatus = {
  reserved: "reserved",
  uploaded: "uploaded",
  deletion_pending: "deletion_pending",
  deleted: "deleted",
} as const;
export type WeleticReviewMediaStatus = (typeof WeleticReviewMediaStatus)[keyof typeof WeleticReviewMediaStatus];

export const WeleticReviewOwnerPrivacyState = {
  active: "active",
  redacted: "redacted",
} as const;
export type WeleticReviewOwnerPrivacyState = (typeof WeleticReviewOwnerPrivacyState)[keyof typeof WeleticReviewOwnerPrivacyState];

export const WeleticReviewRequestStatus = {
  queued: "queued",
  sending: "sending",
  sent: "sent",
  submitted: "submitted",
  expired: "expired",
  cancelled: "cancelled",
  failed: "failed",
} as const;
export type WeleticReviewRequestStatus = (typeof WeleticReviewRequestStatus)[keyof typeof WeleticReviewRequestStatus];

export const WeleticReviewRewardStatus = {
  pending: "pending",
  awarded: "awarded",
  ineligible: "ineligible",
  reversed: "reversed",
  invalidated: "invalidated",
  recovery_pending: "recovery_pending",
  unrecoverable: "unrecoverable",
} as const;
export type WeleticReviewRewardStatus = (typeof WeleticReviewRewardStatus)[keyof typeof WeleticReviewRewardStatus];

export const WeleticRewardArtifactKind = {
  discount_code: "discount_code",
  gift_card: "gift_card",
  store_credit: "store_credit",
} as const;
export type WeleticRewardArtifactKind = (typeof WeleticRewardArtifactKind)[keyof typeof WeleticRewardArtifactKind];

export const WeleticRewardExchangeType = {
  fixed: "fixed",
  incremental: "incremental",
} as const;
export type WeleticRewardExchangeType = (typeof WeleticRewardExchangeType)[keyof typeof WeleticRewardExchangeType];

export const WeleticRewardSalesChannel = {
  online_store: "online_store",
  pos: "pos",
  both: "both",
} as const;
export type WeleticRewardSalesChannel = (typeof WeleticRewardSalesChannel)[keyof typeof WeleticRewardSalesChannel];

export const WeleticRewardStatus = {
  active: "active",
  inactive: "inactive",
  archived: "archived",
} as const;
export type WeleticRewardStatus = (typeof WeleticRewardStatus)[keyof typeof WeleticRewardStatus];

export const WeleticRewardType = {
  amount_off: "amount_off",
  percentage_off: "percentage_off",
  free_shipping: "free_shipping",
  free_product: "free_product",
  gift_card: "gift_card",
  store_credit: "store_credit",
} as const;
export type WeleticRewardType = (typeof WeleticRewardType)[keyof typeof WeleticRewardType];

export const WeleticShopifyPendingInstallationState = {
  pending_approval: "pending_approval",
  mapped: "mapped",
  uninstalled: "uninstalled",
  redacted: "redacted",
} as const;
export type WeleticShopifyPendingInstallationState = (typeof WeleticShopifyPendingInstallationState)[keyof typeof WeleticShopifyPendingInstallationState];

export const WeleticShopifyStoreAccessState = {
  pending_approval: "pending_approval",
  active: "active",
  suspended: "suspended",
} as const;
export type WeleticShopifyStoreAccessState = (typeof WeleticShopifyStoreAccessState)[keyof typeof WeleticShopifyStoreAccessState];

export const WeleticShopifyStoreComplianceState = {
  active: "active",
  frozen: "frozen",
  redacted: "redacted",
} as const;
export type WeleticShopifyStoreComplianceState = (typeof WeleticShopifyStoreComplianceState)[keyof typeof WeleticShopifyStoreComplianceState];

export const WeleticShopperDeliveryState = {
  attempted: "attempted",
  sent: "sent",
} as const;
export type WeleticShopperDeliveryState = (typeof WeleticShopperDeliveryState)[keyof typeof WeleticShopperDeliveryState];

export const WeleticStoreReviewSource = {
  invitation: "invitation",
  open: "open",
  imported: "imported",
} as const;
export type WeleticStoreReviewSource = (typeof WeleticStoreReviewSource)[keyof typeof WeleticStoreReviewSource];

export const WeleticStoreReviewStatus = {
  pending: "pending",
  published: "published",
  hidden: "hidden",
  rejected: "rejected",
  redacted: "redacted",
} as const;
export type WeleticStoreReviewStatus = (typeof WeleticStoreReviewStatus)[keyof typeof WeleticStoreReviewStatus];

export const WeleticSyncStatus = {
  pending: "pending",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
} as const;
export type WeleticSyncStatus = (typeof WeleticSyncStatus)[keyof typeof WeleticSyncStatus];

export const WeleticVipMilestoneMode = {
  amount_spent: "amount_spent",
  points_earned: "points_earned",
  both: "both",
} as const;
export type WeleticVipMilestoneMode = (typeof WeleticVipMilestoneMode)[keyof typeof WeleticVipMilestoneMode];

export const WeleticVipTimeframe = {
  rolling_12m: "rolling_12m",
  calendar_year: "calendar_year",
  lifetime: "lifetime",
} as const;
export type WeleticVipTimeframe = (typeof WeleticVipTimeframe)[keyof typeof WeleticVipTimeframe];

export const WeleticVoucherCleanupSource = {
  customer_redact: "customer_redact",
  app_uninstalled: "app_uninstalled",
  shop_redact: "shop_redact",
  review_invalidation: "review_invalidation",
} as const;
export type WeleticVoucherCleanupSource = (typeof WeleticVoucherCleanupSource)[keyof typeof WeleticVoucherCleanupSource];

export const WeleticVoucherCleanupStatus = {
  pending: "pending",
  processing: "processing",
  retrying: "retrying",
  completed: "completed",
  dead_letter: "dead_letter",
  cancelled: "cancelled",
} as const;
export type WeleticVoucherCleanupStatus = (typeof WeleticVoucherCleanupStatus)[keyof typeof WeleticVoucherCleanupStatus];

export const WeleticWebhookStatus = {
  received: "received",
  processed: "processed",
  ignored: "ignored",
  failed: "failed",
} as const;
export type WeleticWebhookStatus = (typeof WeleticWebhookStatus)[keyof typeof WeleticWebhookStatus];

export const WorkflowTrigger = {
  partnerEnrolled: "partnerEnrolled",
  partnerMetricsUpdated: "partnerMetricsUpdated",
  clickRecorded: "clickRecorded",
  commissionEarned: "commissionEarned",
  leadRecorded: "leadRecorded",
  saleRecorded: "saleRecorded",
} as const;
export type WorkflowTrigger = (typeof WorkflowTrigger)[keyof typeof WorkflowTrigger];

export const WorkspaceRole = {
  owner: "owner",
  member: "member",
  viewer: "viewer",
  billing: "billing",
} as const;
export type WorkspaceRole = (typeof WorkspaceRole)[keyof typeof WorkspaceRole];

// Central dictionary of all runtime enums
export const ALL_ENUMS = {
  BountyPerformanceScope,
  BountyStartMode,
  BountySubmissionFrequency,
  BountySubmissionRejectionReason,
  BountySubmissionStatus,
  BountyType,
  CampaignStatus,
  CampaignType,
  Category,
  CommissionStatus,
  CommissionType,
  DiscountProvider,
  DubProduct,
  EmailDomainStatus,
  EventType,
  FolderAccessLevel,
  FolderType,
  FolderUserRole,
  FraudAlertStatus,
  FraudEventStatus,
  FraudRuleType,
  IdentityVerificationStatus,
  IndustryInterest,
  InvoiceStatus,
  InvoiceType,
  LinkScope,
  MessageType,
  MonthlyTraffic,
  NotificationEmailType,
  PartnerBannedReason,
  PartnerLinkStructure,
  PartnerNetworkStatus,
  PartnerPayoutMethod,
  PartnerProfileType,
  PartnerRole,
  PaymentMethod,
  PayoutMode,
  PayoutStatus,
  PlanPeriod,
  PlatformType,
  PostbackReceiver,
  PreferredEarningStructure,
  ProgramApplicationRejectionReason,
  ProgramEnrollmentStatus,
  ProgramPayoutMode,
  ReapplicationTimeframe,
  RewardSpendLimitInterval,
  RewardStructure,
  SalesChannel,
  SubmittedLeadStatus,
  WebhookReceiver,
  WeleticCommissionRuleType,
  WeleticCommissionScope,
  WeleticComplianceRequestStatus,
  WeleticComplianceRequestType,
  WeleticCustomerClassification,
  WeleticCustomerPrivacyIdentityKind,
  WeleticEarningRuleType,
  WeleticFixedAmountMode,
  WeleticLedgerEntryType,
  WeleticLoyaltyAccountStatus,
  WeleticLoyaltyBackfillCreditStatus,
  WeleticLoyaltyBackfillJobStatus,
  WeleticLoyaltyEarnGrantStatus,
  WeleticLoyaltyImportRowStatus,
  WeleticLoyaltyImportStatus,
  WeleticLoyaltyOutboxJobStatus,
  WeleticLoyaltyOutboxJobType,
  WeleticLoyaltyReferralStatus,
  WeleticLoyaltyStatus,
  WeleticLoyaltyTierChangeReason,
  WeleticOrderStatus,
  WeleticPayoutProfileStatus,
  WeleticPointsLedgerEntryType,
  WeleticProductReviewStatus,
  WeleticProductStatus,
  WeleticReconciliationStatus,
  WeleticRedemptionStatus,
  WeleticReferralRewardKind,
  WeleticReviewMediaStatus,
  WeleticReviewOwnerPrivacyState,
  WeleticReviewRequestStatus,
  WeleticReviewRewardStatus,
  WeleticRewardArtifactKind,
  WeleticRewardExchangeType,
  WeleticRewardSalesChannel,
  WeleticRewardStatus,
  WeleticRewardType,
  WeleticShopifyPendingInstallationState,
  WeleticShopifyStoreAccessState,
  WeleticShopifyStoreComplianceState,
  WeleticShopperDeliveryState,
  WeleticStoreReviewSource,
  WeleticStoreReviewStatus,
  WeleticSyncStatus,
  WeleticVipMilestoneMode,
  WeleticVipTimeframe,
  WeleticVoucherCleanupSource,
  WeleticVoucherCleanupStatus,
  WeleticWebhookStatus,
  WorkflowTrigger,
  WorkspaceRole,
} as const;
