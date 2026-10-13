-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "parentResourceType" TEXT,
    "parentResourceId" TEXT,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "description" TEXT,
    "batchId" TEXT,
    "changeSet" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ProgramApplication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "groupId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "country" TEXT,
    "website" TEXT,
    "youtube" TEXT,
    "twitter" TEXT,
    "linkedin" TEXT,
    "instagram" TEXT,
    "tiktok" TEXT,
    "formData" JSONB,
    "userId" TEXT,
    "rejectionReason" TEXT,
    "rejectionNote" TEXT,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProgramApplicationEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "visitedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "submittedAt" DATETIME,
    "approvedAt" DATETIME,
    "rejectedAt" DATETIME,
    "country" TEXT,
    "referralSource" TEXT NOT NULL,
    "referredByPartnerId" TEXT,
    "metadata" JSONB,
    "programApplicationId" TEXT,
    "partnerId" TEXT
);

-- CreateTable
CREATE TABLE "Bounty" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "workflowId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "startsAt" DATETIME,
    "endsAt" DATETIME,
    "startMode" TEXT NOT NULL DEFAULT 'absolute',
    "endsAfterDays" INTEGER,
    "submissionsOpenAt" DATETIME,
    "submissionFrequency" TEXT,
    "maxSubmissions" INTEGER NOT NULL DEFAULT 1,
    "rewardAmount" INTEGER,
    "rewardDescription" TEXT,
    "performanceScope" TEXT,
    "submissionRequirements" JSONB,
    "socialMetricsLastSyncedAt" DATETIME,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BountyGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bountyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "BountyPartnerTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bountyId" TEXT NOT NULL,
    "partnerTagId" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "BountySubmission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "bountyId" TEXT NOT NULL,
    "performanceCount" BIGINT,
    "socialMetricCount" INTEGER,
    "commissionId" TEXT,
    "userId" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "rejectionReason" TEXT,
    "rejectionNote" TEXT,
    "files" JSONB,
    "urls" JSONB,
    "periodNumber" INTEGER NOT NULL DEFAULT 1,
    "socialMetricsLastSyncedAt" DATETIME,
    "completedAt" DATETIME,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "workflowId" TEXT,
    "userId" TEXT NOT NULL,
    "qstashMessageId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "preview" TEXT,
    "from" TEXT,
    "bodyJson" JSONB NOT NULL,
    "scheduledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CampaignGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "CampaignPartnerTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "partnerTagId" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "PartnerComment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Commission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "rewardId" TEXT,
    "linkId" TEXT,
    "payoutId" TEXT,
    "invoiceId" TEXT,
    "customerId" TEXT,
    "eventId" TEXT,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "earnings" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "userId" TEXT,
    "sourceCommissionId" TEXT,
    "sourcePartnerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "email" TEXT,
    "avatar" TEXT,
    "externalId" TEXT,
    "stripeCustomerId" TEXT,
    "linkId" TEXT,
    "clickId" TEXT,
    "clickedAt" DATETIME,
    "country" TEXT,
    "sales" INTEGER NOT NULL DEFAULT 0,
    "saleAmount" BIGINT NOT NULL DEFAULT 0,
    "firstSaleAt" DATETIME,
    "subscriptionCanceledAt" DATETIME,
    "projectId" TEXT NOT NULL,
    "projectConnectId" TEXT,
    "programId" TEXT,
    "partnerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Dashboard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "linkId" TEXT,
    "folderId" TEXT,
    "projectId" TEXT,
    "userId" TEXT,
    "doIndex" BOOLEAN NOT NULL DEFAULT false,
    "password" TEXT,
    "showConversions" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Discount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "type" TEXT NOT NULL DEFAULT 'percentage',
    "maxDuration" INTEGER,
    "description" TEXT,
    "couponId" TEXT,
    "couponTestId" TEXT,
    "autoProvisionEnabledAt" DATETIME,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DiscountCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "discountId" TEXT,
    "partnerId" TEXT NOT NULL,
    "linkId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "disabledAt" DATETIME
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "placeholder" TEXT,
    "expiredUrl" TEXT,
    "notFoundUrl" TEXT,
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "lastChecked" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "logo" TEXT,
    "appleAppSiteAssociation" JSONB,
    "assetLinks" JSONB,
    "deepviewData" JSONB,
    "linkRetentionDays" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "projectId" TEXT
);

-- CreateTable
CREATE TABLE "RegisteredDomain" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "domainId" TEXT,
    "autoRenewalDisabledAt" DATETIME,
    "renewalFee" INTEGER NOT NULL DEFAULT 1200,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DefaultDomains" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dubsh" BOOLEAN NOT NULL DEFAULT true,
    "chatgpt" BOOLEAN NOT NULL DEFAULT true,
    "sptifi" BOOLEAN NOT NULL DEFAULT true,
    "gitnew" BOOLEAN NOT NULL DEFAULT true,
    "callink" BOOLEAN NOT NULL DEFAULT true,
    "amznid" BOOLEAN NOT NULL DEFAULT true,
    "ggllink" BOOLEAN NOT NULL DEFAULT true,
    "figpage" BOOLEAN NOT NULL DEFAULT true,
    "loooooooong" BOOLEAN NOT NULL DEFAULT false,
    "projectId" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "EmailDomain" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resendDomainId" TEXT,
    "lastChecked" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Folder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'default',
    "accessLevel" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FolderUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "folderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FolderAccessRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "folderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FraudRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB,
    "disabledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FraudEventGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "lastEventAt" DATETIME,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "userId" TEXT,
    "resolutionReason" TEXT,
    "resolvedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FraudEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fraudEventGroupId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "linkId" TEXT,
    "customerId" TEXT,
    "eventId" TEXT,
    "sourceProgramId" TEXT,
    "hash" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FraudAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "partnerId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewedById" TEXT,
    "reviewedAt" DATETIME,
    "reviewNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PartnerGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT,
    "clickRewardId" TEXT,
    "leadRewardId" TEXT,
    "saleRewardId" TEXT,
    "referralRewardId" TEXT,
    "discountId" TEXT,
    "linkStructure" TEXT NOT NULL DEFAULT 'short',
    "additionalLinks" JSONB,
    "maxPartnerLinks" INTEGER NOT NULL DEFAULT 0,
    "applicationFormData" JSONB,
    "applicationFormPublishedAt" DATETIME,
    "landerData" JSONB,
    "landerPublishedAt" DATETIME,
    "logo" TEXT,
    "wordmark" TEXT,
    "brandColor" TEXT,
    "holdingPeriodDays" INTEGER NOT NULL DEFAULT 0,
    "autoApprovePartnersEnabledAt" DATETIME,
    "workflowId" TEXT,
    "utmTemplateId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PartnerGroupDefaultLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "groupId" TEXT,
    "domain" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "readme" TEXT,
    "developer" TEXT NOT NULL,
    "website" TEXT NOT NULL,
    "logo" TEXT,
    "screenshots" JSONB,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "installUrl" TEXT,
    "guideUrl" TEXT,
    "category" TEXT,
    "comingSoon" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "InstalledIntegration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "credentials" JSONB,
    "settings" JSONB
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT,
    "workspaceId" TEXT NOT NULL,
    "number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "type" TEXT NOT NULL DEFAULT 'partnerPayout',
    "payoutMode" TEXT NOT NULL DEFAULT 'internal',
    "paymentMethod" TEXT,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "fee" INTEGER NOT NULL DEFAULT 0,
    "refundedAmount" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "externalAmount" INTEGER NOT NULL DEFAULT 0,
    "receiptUrl" TEXT,
    "refundReason" TEXT,
    "failedReason" TEXT,
    "registeredDomains" JSONB,
    "stripeChargeMetadata" JSONB,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" DATETIME
);

-- CreateTable
CREATE TABLE "jackson_index" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "storeKey" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "jackson_store" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "iv" TEXT,
    "tag" TEXT,
    "namespace" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modifiedAt" DATETIME
);

-- CreateTable
CREATE TABLE "jackson_ttl" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" BIGINT NOT NULL
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "options" JSONB,
    "scheduledFor" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SubmittedLead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "formData" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Link" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "domain" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "shortLink" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" DATETIME,
    "expiredUrl" TEXT,
    "disabledAt" DATETIME,
    "password" TEXT,
    "trackConversion" BOOLEAN NOT NULL DEFAULT false,
    "proxy" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT,
    "description" TEXT,
    "image" TEXT,
    "video" TEXT,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_term" TEXT,
    "utm_content" TEXT,
    "rewrite" BOOLEAN NOT NULL DEFAULT false,
    "linkRetentionCleanupDisabledAt" DATETIME,
    "doIndex" BOOLEAN NOT NULL DEFAULT false,
    "ios" TEXT,
    "android" TEXT,
    "geo" JSONB,
    "testVariants" JSONB,
    "testStartedAt" DATETIME,
    "testCompletedAt" DATETIME,
    "userId" TEXT,
    "projectId" TEXT,
    "folderId" TEXT,
    "externalId" TEXT,
    "tenantId" TEXT,
    "publicStats" BOOLEAN NOT NULL DEFAULT false,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "leads" INTEGER NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "sales" INTEGER NOT NULL DEFAULT 0,
    "saleAmount" BIGINT NOT NULL DEFAULT 0,
    "lastClicked" DATETIME,
    "lastLeadAt" DATETIME,
    "lastConversionAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "comments" TEXT,
    "programId" TEXT,
    "partnerId" TEXT,
    "partnerGroupDefaultLinkId" TEXT
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "senderPartnerId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'direct',
    "subject" TEXT,
    "text" TEXT NOT NULL,
    "readInApp" DATETIME,
    "readInEmail" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "YearInReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "year" INTEGER NOT NULL,
    "totalLinks" INTEGER NOT NULL,
    "totalClicks" INTEGER NOT NULL,
    "topLinks" JSONB NOT NULL,
    "topCountries" JSONB NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME
);

-- CreateTable
CREATE TABLE "PartnerRewind" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "year" INTEGER NOT NULL,
    "totalClicks" INTEGER NOT NULL,
    "totalLeads" INTEGER NOT NULL,
    "totalRevenue" INTEGER NOT NULL,
    "totalEarnings" INTEGER NOT NULL,
    "partnerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME
);

-- CreateTable
CREATE TABLE "ProgramCategory" (
    "programId" TEXT NOT NULL,
    "category" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "ProgramSimilarity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "similarProgramId" TEXT NOT NULL,
    "similarityScore" REAL NOT NULL,
    "categorySimilarityScore" REAL NOT NULL,
    "partnerSimilarityScore" REAL NOT NULL,
    "performanceSimilarityScore" REAL NOT NULL
);

-- CreateTable
CREATE TABLE "DiscoveredPartner" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "starredAt" DATETIME,
    "ignoredAt" DATETIME,
    "invitedAt" DATETIME,
    "messagedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "NotificationEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emailId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "messageId" TEXT,
    "bountyId" TEXT,
    "campaignId" TEXT,
    "programId" TEXT,
    "partnerId" TEXT,
    "recipientUserId" TEXT,
    "deliveredAt" DATETIME,
    "openedAt" DATETIME,
    "bouncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UserNotificationPreferences" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "dubLinks" BOOLEAN NOT NULL DEFAULT true,
    "dubPartners" BOOLEAN NOT NULL DEFAULT true,
    "partnerAccount" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectUserId" TEXT NOT NULL,
    "linkUsageSummary" BOOLEAN NOT NULL DEFAULT true,
    "domainConfigurationUpdates" BOOLEAN NOT NULL DEFAULT true,
    "newPartnerSale" BOOLEAN NOT NULL DEFAULT true,
    "newPartnerApplication" BOOLEAN NOT NULL DEFAULT false,
    "pendingApplicationsSummary" BOOLEAN NOT NULL DEFAULT true,
    "newBountySubmitted" BOOLEAN NOT NULL DEFAULT true,
    "newMessageFromPartner" BOOLEAN NOT NULL DEFAULT true,
    "fraudEventsSummary" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "PartnerNotificationPreferences" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "partnerUserId" TEXT NOT NULL,
    "commissionCreated" BOOLEAN NOT NULL DEFAULT true,
    "applicationApproved" BOOLEAN NOT NULL DEFAULT true,
    "newMessageFromProgram" BOOLEAN NOT NULL DEFAULT true,
    "marketingCampaign" BOOLEAN NOT NULL DEFAULT true,
    "connectPayoutReminder" BOOLEAN NOT NULL DEFAULT true,
    "monthlyProgramSummary" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "OAuthApp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "integrationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "hashedClientSecret" TEXT NOT NULL,
    "partialClientSecret" TEXT NOT NULL,
    "redirectUris" JSONB NOT NULL,
    "pkce" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "OAuthCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "scopes" TEXT,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT,
    "codeChallengeMethod" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OAuthRefreshToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "installationId" TEXT NOT NULL,
    "accessTokenId" TEXT NOT NULL,
    "hashedRefreshToken" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Partner" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "username" TEXT,
    "email" TEXT,
    "image" TEXT,
    "description" TEXT,
    "country" TEXT,
    "preferredLocale" TEXT NOT NULL DEFAULT 'en',
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "preferredDisplayCurrency" TEXT,
    "preferredPayoutCurrency" TEXT,
    "companyName" TEXT,
    "profileType" TEXT NOT NULL DEFAULT 'individual',
    "networkStatus" TEXT NOT NULL DEFAULT 'draft',
    "identityVerificationStatus" TEXT,
    "identityVerifiedAt" DATETIME,
    "veriffSessionId" TEXT,
    "veriffMetadata" JSONB,
    "defaultPayoutMethod" TEXT,
    "payoutsEnabledAt" DATETIME,
    "connectPayoutsLastRemindedAt" DATETIME,
    "paypalEmail" TEXT,
    "stripeConnectId" TEXT,
    "stripeRecipientId" TEXT,
    "payoutMethodHash" TEXT,
    "cryptoWalletAddress" TEXT,
    "tremendousEmail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "submittedAt" DATETIME,
    "reviewedAt" DATETIME,
    "trustedAt" DATETIME,
    "invoiceSettings" JSONB,
    "changeHistoryLog" JSONB,
    "referredByPartnerId" TEXT,
    "monthlyTraffic" TEXT
);

-- CreateTable
CREATE TABLE "PartnerInvite" (
    "email" TEXT NOT NULL,
    "expires" DATETIME NOT NULL,
    "partnerId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PartnerUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "role" TEXT NOT NULL DEFAULT 'member',
    "userId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PartnerIndustryInterest" (
    "partnerId" TEXT NOT NULL,
    "industryInterest" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "PartnerPreferredEarningStructure" (
    "partnerId" TEXT NOT NULL,
    "preferredEarningStructure" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "PartnerSalesChannel" (
    "partnerId" TEXT NOT NULL,
    "salesChannel" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "mode" TEXT,
    "method" TEXT,
    "description" TEXT,
    "periodStart" DATETIME,
    "periodEnd" DATETIME,
    "paypalTransferId" TEXT,
    "stripeTransferId" TEXT,
    "stripePayoutId" TEXT,
    "stripePayoutTraceId" TEXT,
    "tremendousOrderId" TEXT,
    "failureReason" TEXT,
    "webhookEventId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT,
    "initiatedAt" DATETIME,
    "paidAt" DATETIME
);

-- CreateTable
CREATE TABLE "PartnerPlatform" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "partnerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "platformId" TEXT,
    "avatarUrl" TEXT,
    "subscribers" BIGINT NOT NULL DEFAULT 0,
    "posts" BIGINT NOT NULL DEFAULT 0,
    "views" BIGINT NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "verifiedAt" DATETIME,
    "lastCheckedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Postback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "partnerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "triggers" JSONB NOT NULL,
    "receiver" TEXT NOT NULL,
    "disabledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Program" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "defaultFolderId" TEXT NOT NULL,
    "defaultGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "domain" TEXT,
    "url" TEXT,
    "logo" TEXT,
    "description" TEXT,
    "primaryRewardEvent" TEXT NOT NULL DEFAULT 'sale',
    "minPayoutAmount" INTEGER NOT NULL DEFAULT 0,
    "accountingCurrency" TEXT NOT NULL DEFAULT 'USD',
    "payoutMode" TEXT NOT NULL DEFAULT 'internal',
    "inviteEmailData" JSONB,
    "embedData" JSONB,
    "resources" JSONB,
    "referralFormData" JSONB,
    "applicationRequirements" JSONB,
    "termsUrl" TEXT,
    "helpUrl" TEXT,
    "supportEmail" TEXT,
    "tremendousCampaignId" TEXT,
    "messagingEnabledAt" DATETIME,
    "partnerNetworkEnabledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "deactivatedAt" DATETIME,
    "addedToMarketplaceAt" DATETIME,
    "featuredOnMarketplaceAt" DATETIME,
    "marketplaceHeaderImage" TEXT,
    "marketplaceRanking" INTEGER NOT NULL DEFAULT 2147483647
);

-- CreateTable
CREATE TABLE "ProgramEnrollment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "partnerId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "tenantId" TEXT,
    "groupId" TEXT,
    "applicationId" TEXT,
    "clickRewardId" TEXT,
    "leadRewardId" TEXT,
    "saleRewardId" TEXT,
    "referralRewardId" TEXT,
    "discountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalClicks" INTEGER NOT NULL DEFAULT 0,
    "totalLeads" INTEGER NOT NULL DEFAULT 0,
    "totalConversions" INTEGER NOT NULL DEFAULT 0,
    "totalSales" INTEGER NOT NULL DEFAULT 0,
    "totalSaleAmount" BIGINT NOT NULL DEFAULT 0,
    "totalCommissions" BIGINT NOT NULL DEFAULT 0,
    "netRevenue" BIGINT NOT NULL DEFAULT 0,
    "earningsPerClick" REAL NOT NULL DEFAULT 0,
    "averageLifetimeValue" REAL,
    "clickToLeadRate" REAL,
    "clickToConversionRate" REAL,
    "leadToConversionRate" REAL,
    "returnOnAdSpend" REAL,
    "lastConversionAt" DATETIME,
    "daysSinceLastConversion" INTEGER,
    "consistencyScore" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "customerDataSharingEnabledAt" DATETIME,
    "groupMoveDisabledAt" DATETIME,
    "bannedAt" DATETIME,
    "bannedReason" TEXT,
    "reapplicationTimeframe" TEXT NOT NULL DEFAULT 'standard',
    "riskMonitoringDisabledAt" DATETIME
);

-- CreateTable
CREATE TABLE "Reward" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT,
    "description" TEXT,
    "tooltipDescription" TEXT,
    "event" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'percentage',
    "amountInCents" INTEGER,
    "amountInPercentage" DECIMAL,
    "maxDuration" INTEGER,
    "modifiers" JSONB,
    "config" JSONB,
    "spendLimitAmount" INTEGER,
    "spendLimitInterval" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" DATETIME,
    "image" TEXT,
    "isMachine" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "passwordHash" TEXT,
    "invalidLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" DATETIME,
    "defaultWorkspace" TEXT,
    "defaultPartnerId" TEXT,
    "source" TEXT,
    "sentMail" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "refresh_token_expires_in" INTEGER,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'blue',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "projectId" TEXT
);

-- CreateTable
CREATE TABLE "LinkTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "linkId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "PartnerTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProgramPartnerTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "partnerTagId" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Token" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "hashedKey" TEXT NOT NULL,
    "partialKey" TEXT NOT NULL,
    "expires" DATETIME,
    "lastUsed" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "RestrictedToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "hashedKey" TEXT NOT NULL,
    "partialKey" TEXT NOT NULL,
    "scopes" TEXT,
    "expires" DATETIME,
    "lastUsed" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "installationId" TEXT
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" DATETIME NOT NULL,
    "isAdminImpersonation" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "EmailVerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UtmTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_term" TEXT,
    "utm_content" TEXT,
    "ref" TEXT,
    "userId" TEXT,
    "projectId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "installationId" TEXT,
    "receiver" TEXT NOT NULL DEFAULT 'user',
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "triggers" JSONB NOT NULL,
    "linkScope" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastFailedAt" DATETIME,
    "disabledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LinkWebhook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "linkId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FolderWebhook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "folderId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticShopifyStore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopCurrency" TEXT NOT NULL,
    "currencyVerifiedAt" DATETIME,
    "installationGeneration" TEXT,
    "storeAccessState" TEXT NOT NULL DEFAULT 'pending_approval',
    "storeAccessRevision" INTEGER NOT NULL DEFAULT 1,
    "defaultLocale" TEXT NOT NULL DEFAULT 'en',
    "apiVersion" TEXT NOT NULL,
    "syncStatus" TEXT NOT NULL DEFAULT 'pending',
    "lastFullSyncAt" DATETIME,
    "lastIncrementalAt" DATETIME,
    "lastReconciledAt" DATETIME,
    "lastSyncError" TEXT,
    "complianceState" TEXT NOT NULL DEFAULT 'active',
    "uninstalledAt" DATETIME,
    "redactedAt" DATETIME,
    "financialRetentionUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyInstallationCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "credentialCiphertext" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyStoreAccessChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "previousState" TEXT NOT NULL,
    "nextState" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "operator" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticShopifyPendingInstallation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appId" TEXT NOT NULL,
    "identityKeyId" TEXT NOT NULL,
    "shopDomainDigest" TEXT NOT NULL,
    "installationGeneration" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending_approval',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "mappedStoreId" TEXT,
    "authenticatedAt" DATETIME,
    "uninstalledAt" DATETIME,
    "redactedAt" DATETIME,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyPendingInstallationChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pendingInstallationId" TEXT NOT NULL,
    "mappedStoreId" TEXT,
    "installationGeneration" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "operation" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticShopifyAppSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL,
    "expiresAt" DATETIME,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifySessionCoordination" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "leaseEpoch" BIGINT NOT NULL DEFAULT 0,
    "leaseOwnerHash" TEXT,
    "leaseExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyMarket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "handle" TEXT,
    "catalogExternalId" TEXT,
    "countryCodes" JSONB NOT NULL,
    "currencyCodes" JSONB NOT NULL,
    "rootUrls" JSONB,
    "webPresenceUrl" TEXT,
    "defaultLocale" TEXT,
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "descriptionHtml" TEXT,
    "productType" TEXT,
    "vendor" TEXT,
    "tags" JSONB,
    "collectionExternalIds" JSONB,
    "featuredImageUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "availableForSale" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "options" JSONB,
    "imageUrl" TEXT,
    "availableForSale" BOOLEAN NOT NULL DEFAULT true,
    "inventoryQuantity" INTEGER,
    "shopPrice" BIGINT NOT NULL,
    "shopCompareAtPrice" BIGINT,
    "shopCurrency" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyTranslation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "marketId" TEXT,
    "marketKey" TEXT NOT NULL DEFAULT '*',
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "descriptionHtml" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyMarketPrice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "variantId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "compareAtAmount" BIGINT,
    "currency" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifySyncRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "cursor" TEXT,
    "stats" JSONB,
    "error" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyWebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "authenticatedBodyDigest" TEXT,
    "storeInstallationGeneration" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "payload" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "occurredAt" DATETIME,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticProductLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "marketId" TEXT,
    "countryCode" TEXT,
    "linkId" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "subId" TEXT,
    "targetUrl" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticFxRateSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "rate" DECIMAL NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "capturedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticCommerceOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "partnerId" TEXT,
    "linkId" TEXT,
    "marketId" TEXT,
    "marketCountryCode" TEXT,
    "externalId" TEXT NOT NULL,
    "orderName" TEXT,
    "checkoutToken" TEXT,
    "customerOrderSequence" INTEGER,
    "customerClassification" TEXT NOT NULL DEFAULT 'unknown',
    "customerSegmentIds" JSONB,
    "shopifyRewardSnapshot" JSONB,
    "loyaltyPolicyRevisionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'paid',
    "presentmentCurrency" TEXT NOT NULL,
    "presentmentSubtotal" BIGINT NOT NULL,
    "presentmentDiscount" BIGINT NOT NULL DEFAULT 0,
    "presentmentNet" BIGINT NOT NULL,
    "presentmentTax" BIGINT NOT NULL DEFAULT 0,
    "presentmentShipping" BIGINT NOT NULL DEFAULT 0,
    "presentmentTotal" BIGINT NOT NULL,
    "shopCurrency" TEXT NOT NULL,
    "shopSubtotal" BIGINT NOT NULL,
    "shopDiscount" BIGINT NOT NULL DEFAULT 0,
    "shopNet" BIGINT NOT NULL,
    "shopTax" BIGINT NOT NULL DEFAULT 0,
    "shopShipping" BIGINT NOT NULL DEFAULT 0,
    "shopTotal" BIGINT NOT NULL,
    "accountingCurrency" TEXT NOT NULL,
    "accountingNet" BIGINT NOT NULL,
    "accountingTotal" BIGINT NOT NULL,
    "accountingFxRate" DECIMAL NOT NULL,
    "fxRateSnapshotId" TEXT,
    "occurredAt" DATETIME NOT NULL,
    "processedAt" DATETIME,
    "analyticsRecordedAt" DATETIME,
    "dubStatsRecordedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "shopperId" TEXT
);

-- CreateTable
CREATE TABLE "WeleticCommerceOrderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "sku" TEXT,
    "sellingPlanId" TEXT,
    "sellingPlanCategory" TEXT,
    "subscriptionSeriesKey" TEXT,
    "subscriptionSequence" INTEGER,
    "collectionExternalIds" JSONB,
    "productTags" JSONB,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "presentmentGross" BIGINT NOT NULL,
    "presentmentDiscount" BIGINT NOT NULL DEFAULT 0,
    "presentmentNet" BIGINT NOT NULL,
    "shopGross" BIGINT NOT NULL,
    "shopDiscount" BIGINT NOT NULL DEFAULT 0,
    "shopNet" BIGINT NOT NULL,
    "accountingNet" BIGINT NOT NULL,
    "commissionableAccountingAmount" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticCommerceRefund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "presentmentCurrency" TEXT NOT NULL,
    "presentmentAmount" BIGINT NOT NULL,
    "shopCurrency" TEXT NOT NULL,
    "shopAmount" BIGINT NOT NULL,
    "accountingCurrency" TEXT NOT NULL,
    "accountingAmount" BIGINT NOT NULL,
    "accountingFxRate" DECIMAL NOT NULL,
    "fxRateSnapshotId" TEXT,
    "occurredAt" DATETIME NOT NULL,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticCommerceRefundLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "refundId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "presentmentAmount" BIGINT NOT NULL,
    "shopAmount" BIGINT NOT NULL,
    "accountingAmount" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticCommissionRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "logicalKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "programId" TEXT NOT NULL,
    "partnerId" TEXT,
    "scope" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "fixedAmountMode" TEXT NOT NULL DEFAULT 'line',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "collectionExternalId" TEXT,
    "productId" TEXT,
    "variantId" TEXT,
    "promotionCode" TEXT,
    "tag" TEXT,
    "basisPoints" INTEGER,
    "fixedAmount" BIGINT,
    "currency" TEXT,
    "minOrderAmount" BIGINT,
    "maxCommissionAmount" BIGINT,
    "effectiveAt" DATETIME NOT NULL,
    "expiresAt" DATETIME,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticCommissionCalculation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entryType" TEXT NOT NULL,
    "orderLineId" TEXT,
    "refundLineId" TEXT,
    "commissionId" TEXT,
    "ruleId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "accountingCurrency" TEXT NOT NULL,
    "commissionableAmount" BIGINT NOT NULL,
    "earnings" BIGINT NOT NULL,
    "calculationVersion" INTEGER NOT NULL DEFAULT 1,
    "inputs" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticPayoutProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "partnerId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "payoutCurrency" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "providerAccountRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "taxResidencyCountry" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "details" JSONB,
    "verifiedAt" DATETIME,
    "verifiedByUserId" TEXT,
    "verificationNotes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticPayoutQuote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "payoutId" TEXT NOT NULL,
    "payoutProfileId" TEXT,
    "accountingAmount" BIGINT NOT NULL,
    "accountingCurrency" TEXT NOT NULL,
    "payoutAmount" BIGINT NOT NULL,
    "payoutCurrency" TEXT NOT NULL,
    "fxRate" DECIMAL NOT NULL,
    "feeAmount" BIGINT NOT NULL DEFAULT 0,
    "provider" TEXT NOT NULL,
    "providerQuoteRef" TEXT,
    "fxRateSnapshotId" TEXT,
    "quotedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticPayoutStatement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "payoutId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "accountingCurrency" TEXT NOT NULL,
    "payoutCurrency" TEXT NOT NULL,
    "storageKey" TEXT,
    "snapshot" JSONB NOT NULL,
    "generatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticReconciliationIssue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "externalKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "details" JSONB NOT NULL,
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyComplianceRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "authenticatedBodyDigest" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "phase" TEXT NOT NULL DEFAULT 'received',
    "subjectKind" TEXT,
    "subjectKeyId" TEXT,
    "subjectDigest" TEXT,
    "payloadCiphertext" TEXT,
    "cursor" JSONB,
    "progress" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 10,
    "leaseVersion" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" DATETIME,
    "lockedBy" TEXT,
    "nextRetryAt" DATETIME,
    "lastError" TEXT,
    "triggeredAt" DATETIME,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyComplianceArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "encryptionVersion" TEXT NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "byteSize" BIGINT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "downloadTokenHash" TEXT,
    "downloadTokenCiphertext" TEXT,
    "downloadTokenKeyId" TEXT,
    "downloadTokenExpiresAt" DATETIME,
    "deliveredAt" DATETIME,
    "downloadedAt" DATETIME,
    "deletedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyCustomerPrivacyTombstone" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "identityKind" TEXT NOT NULL,
    "identityKeyId" TEXT NOT NULL,
    "customerDigest" TEXT NOT NULL,
    "shopperId" TEXT,
    "accountId" TEXT,
    "sourceRequestId" TEXT,
    "redactedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyShopPrivacyTombstone" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "identityKeyId" TEXT NOT NULL,
    "shopDomainDigest" TEXT NOT NULL,
    "sourceRequestId" TEXT,
    "redactedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyVoucherCleanup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "redemptionId" TEXT NOT NULL,
    "sourceRequestId" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expectedDiscountCode" TEXT NOT NULL,
    "expectedDiscountCodeCanonical" TEXT NOT NULL,
    "expectedDiscountId" TEXT,
    "ownershipSnapshot" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 10,
    "leaseVersion" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" DATETIME,
    "lockedBy" TEXT,
    "nextRetryAt" DATETIME,
    "lastError" TEXT,
    "remoteVerifiedAt" DATETIME,
    "remoteUsageCount" INTEGER,
    "remoteUsageObservedAt" DATETIME,
    "remoteDeactivationStartedAt" DATETIME,
    "remoteDeactivatedAt" DATETIME,
    "remoteOutcome" TEXT,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyVoucherCleanupRequestLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "cleanupId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticShopifyFlowPointsGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "allowCredit" BOOLEAN NOT NULL DEFAULT false,
    "allowDebit" BOOLEAN NOT NULL DEFAULT false,
    "maxAbsolutePointsPerAction" DECIMAL NOT NULL,
    "absolutePointsBudget" DECIMAL NOT NULL,
    "absolutePointsUsed" DECIMAL NOT NULL DEFAULT 0,
    "expiresAt" DATETIME NOT NULL,
    "approvedByShopifyUserId" TEXT,
    "approvedMerchantActionId" TEXT NOT NULL,
    "revokedAt" DATETIME,
    "revokedByShopifyUserId" TEXT,
    "revokedMerchantActionId" TEXT,
    "staffRedactedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyFlowActionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "runKey" TEXT NOT NULL,
    "payloadDigest" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "grantRevision" INTEGER NOT NULL,
    "ledgerEntryId" TEXT NOT NULL,
    "pointsDelta" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticShopper" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "locale" TEXT DEFAULT 'en',
    "tags" JSONB,
    "segmentIds" JSONB,
    "acceptsMarketing" BOOLEAN NOT NULL DEFAULT false,
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "totalSpent" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyProgram" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Loyalty Program',
    "status" TEXT NOT NULL DEFAULT 'active',
    "pointNameSingular" TEXT NOT NULL DEFAULT 'Point',
    "pointNamePlural" TEXT NOT NULL DEFAULT 'Points',
    "pointsPerCurrencyUnit" DECIMAL NOT NULL DEFAULT 1.0,
    "liabilityValuationCurrency" TEXT,
    "liabilityMinorUnitsNumerator" BIGINT,
    "liabilityPointsDenominator" BIGINT,
    "holdingPeriodDays" INTEGER NOT NULL DEFAULT 0,
    "pointsExpiryMonths" INTEGER NOT NULL DEFAULT 0,
    "pointsExpiryDays" INTEGER NOT NULL DEFAULT 0,
    "pointsExpiryWarningDays" INTEGER NOT NULL DEFAULT 30,
    "pointsExpiryLastChanceDays" INTEGER NOT NULL DEFAULT 3,
    "pointsExpiryWarningEnabled" BOOLEAN NOT NULL DEFAULT true,
    "pointsExpiryLastChanceEnabled" BOOLEAN NOT NULL DEFAULT true,
    "pointsExpiryPolicyAnchorAt" DATETIME,
    "pointsExpiryPolicyVersion" INTEGER NOT NULL DEFAULT 0,
    "earnPolicyVersion" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "killSwitchActive" BOOLEAN NOT NULL DEFAULT false,
    "activatedAt" DATETIME,
    "disabledAt" DATETIME,
    "enableOnlineStoreLauncher" BOOLEAN NOT NULL DEFAULT true,
    "enableCustomerAccountHub" BOOLEAN NOT NULL DEFAULT true,
    "enableCheckoutExtension" BOOLEAN NOT NULL DEFAULT true,
    "enableProductPointsWidget" BOOLEAN NOT NULL DEFAULT true,
    "enableMetafieldsSync" BOOLEAN NOT NULL DEFAULT true,
    "surfaceFlags" JSONB,
    "vipMilestoneMode" TEXT NOT NULL DEFAULT 'amount_spent',
    "vipTimeframe" TEXT NOT NULL DEFAULT 'rolling_12m',
    "vipDowngradeGraceDays" INTEGER NOT NULL DEFAULT 30,
    "vipAutoDowngradeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "branding" JSONB,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyBonusCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "multiplier" DECIMAL NOT NULL DEFAULT 2.0,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "eligibleTierIds" JSONB,
    "eligibleSkus" JSONB,
    "eligibleCollectionIds" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyEarningRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "triggerCode" TEXT NOT NULL DEFAULT 'order_paid',
    "ruleType" TEXT NOT NULL DEFAULT 'multiplier',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "multiplier" DECIMAL NOT NULL DEFAULT 1.0,
    "fixedPoints" BIGINT,
    "minOrderSubtotal" DECIMAL,
    "maxPointsPerEvent" BIGINT,
    "maxEventsPerCustomer" INTEGER,
    "limitInterval" TEXT,
    "eligibleTierIds" JSONB,
    "conditions" JSONB,
    "purchasePolicy" JSONB,
    "excludeDiscountedItems" BOOLEAN NOT NULL DEFAULT false,
    "excludeTaxesAndShipping" BOOLEAN NOT NULL DEFAULT true,
    "startAt" DATETIME,
    "endAt" DATETIME,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyReviewIntegration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "encryptedApiToken" TEXT NOT NULL,
    "webhookIds" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastVerifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyTier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "tierOrder" INTEGER NOT NULL DEFAULT 1,
    "minSpendThreshold" BIGINT NOT NULL DEFAULT 0,
    "minPointsThreshold" BIGINT NOT NULL DEFAULT 0,
    "pointsMultiplier" DECIMAL NOT NULL DEFAULT 1.0,
    "entryBonusPoints" BIGINT NOT NULL DEFAULT 0,
    "gracePeriodDays" INTEGER,
    "perks" JSONB,
    "iconUrl" TEXT,
    "color" TEXT,
    "criteria" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyEarnPolicyRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveAt" DATETIME NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "snapshot" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyTierHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "sequenceNumber" INTEGER,
    "fromTierId" TEXT,
    "toTierId" TEXT,
    "changeReason" TEXT NOT NULL DEFAULT 'threshold_reached',
    "notes" TEXT,
    "qualifyingSpendSnapshot" BIGINT,
    "qualifyingPointsSnapshot" BIGINT,
    "effectiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "shopperId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "ledgerVersion" INTEGER NOT NULL DEFAULT 0,
    "cachedPointsBalance" BIGINT NOT NULL DEFAULT 0,
    "cachedPendingPoints" BIGINT NOT NULL DEFAULT 0,
    "lifetimePointsEarned" BIGINT NOT NULL DEFAULT 0,
    "lifetimePointsRedeemed" BIGINT NOT NULL DEFAULT 0,
    "lastQualifyingActivityAt" DATETIME,
    "nextExpiryDate" DATETIME,
    "pointsExpiryPolicyVersion" INTEGER NOT NULL DEFAULT 0,
    "pointsExpiryJobsScheduledAt" DATETIME,
    "referralCode" TEXT,
    "referredById" TEXT,
    "referralCount" INTEGER NOT NULL DEFAULT 0,
    "referralPointsEarned" BIGINT NOT NULL DEFAULT 0,
    "currentTierId" TEXT,
    "tierExpiresAt" DATETIME,
    "tierSpendRolling12Months" BIGINT NOT NULL DEFAULT 0,
    "tierPointsRolling12Months" BIGINT NOT NULL DEFAULT 0,
    "enrolledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyEarnGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "shopperId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "currency" TEXT NOT NULL,
    "eligibleSubtotalAmount" BIGINT NOT NULL,
    "orderTotalAmount" BIGINT NOT NULL,
    "grossPoints" BIGINT NOT NULL,
    "pendingPoints" BIGINT NOT NULL DEFAULT 0,
    "settledPoints" BIGINT NOT NULL DEFAULT 0,
    "reversedPoints" BIGINT NOT NULL DEFAULT 0,
    "availableAt" DATETIME NOT NULL,
    "settledAt" DATETIME,
    "voidedAt" DATETIME,
    "selectedRuleId" TEXT,
    "selectedCampaignId" TEXT,
    "tierId" TEXT,
    "pointsPerCurrencyUnit" DECIMAL NOT NULL,
    "ruleMultiplier" DECIMAL NOT NULL DEFAULT 1.0,
    "campaignMultiplier" DECIMAL NOT NULL DEFAULT 1.0,
    "tierMultiplier" DECIMAL NOT NULL DEFAULT 1.0,
    "effectiveMultiplier" DECIMAL NOT NULL,
    "calculationSnapshot" JSONB,
    "policyRevisionId" TEXT,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyOrderLineEarn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "grantId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "lineExternalId" TEXT,
    "title" TEXT,
    "quantity" INTEGER NOT NULL,
    "lineNetAmount" BIGINT NOT NULL,
    "awardedPoints" BIGINT NOT NULL,
    "reversedPoints" BIGINT NOT NULL DEFAULT 0,
    "isExcluded" BOOLEAN NOT NULL DEFAULT false,
    "exclusionReason" TEXT,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticPointsLedgerEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "entryType" TEXT NOT NULL,
    "pointsDelta" BIGINT NOT NULL,
    "pendingDelta" BIGINT NOT NULL DEFAULT 0,
    "balanceAfter" BIGINT NOT NULL,
    "grantId" TEXT,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticRewardDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rewardType" TEXT NOT NULL,
    "salesChannel" TEXT NOT NULL DEFAULT 'online_store',
    "exchangeType" TEXT NOT NULL DEFAULT 'fixed',
    "pointsCost" BIGINT NOT NULL,
    "pointsStep" BIGINT,
    "minPointsCost" BIGINT,
    "maxPointsCost" BIGINT,
    "discountValue" DECIMAL,
    "maxDiscountValue" DECIMAL,
    "minOrderAmount" DECIMAL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "shopifyPriceRuleId" TEXT,
    "appliesToResource" TEXT DEFAULT 'entire_order',
    "entitledCollectionIds" JSONB,
    "entitledProductIds" JSONB,
    "entitledVariantIds" JSONB,
    "combinesWithProductDiscounts" BOOLEAN NOT NULL DEFAULT false,
    "combinesWithOrderDiscounts" BOOLEAN NOT NULL DEFAULT false,
    "combinesWithShippingDiscounts" BOOLEAN NOT NULL DEFAULT false,
    "usageLimit" INTEGER,
    "usageLimitPerCustomer" INTEGER DEFAULT 1,
    "expiresInDays" INTEGER,
    "purchasePolicy" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticRewardRedemption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "accountId" TEXT,
    "shopperId" TEXT,
    "fulfillmentSource" TEXT,
    "fulfillmentReference" TEXT,
    "rewardDefinitionId" TEXT NOT NULL,
    "pointsSpent" BIGINT NOT NULL,
    "shopifyDiscountCode" TEXT NOT NULL,
    "shopifyDiscountCodeCanonical" TEXT NOT NULL,
    "settlementQuarantinedAt" DATETIME,
    "settlementQuarantineReason" TEXT,
    "shopifyDiscountId" TEXT,
    "shopifyPriceRuleId" TEXT,
    "artifactKind" TEXT NOT NULL DEFAULT 'discount_code',
    "shopifyGiftCardId" TEXT,
    "shopifyStoreCreditTransactionId" TEXT,
    "idempotencyKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'provisioning',
    "compensationReason" TEXT,
    "orderId" TEXT,
    "expiresAt" DATETIME,
    "issuanceConfirmedAt" DATETIME,
    "usedAt" DATETIME,
    "usedAtBasis" TEXT,
    "ledgerEntryId" TEXT,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticRewardCouponUse" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "redemptionId" TEXT NOT NULL,
    "shopperId" TEXT NOT NULL,
    "orderExternalId" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "usedAt" DATETIME NOT NULL,
    "usedAtBasis" TEXT,
    "discountAmountMinor" BIGINT,
    "currency" TEXT,
    "amountUnavailableReason" TEXT,
    "priorRedemptionStatus" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyReferralRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "advocatePointsReward" BIGINT NOT NULL DEFAULT 100,
    "refereePointsReward" BIGINT NOT NULL DEFAULT 50,
    "advocateRewardKind" TEXT NOT NULL DEFAULT 'points',
    "refereeRewardKind" TEXT NOT NULL DEFAULT 'points',
    "advocateRewardDefinitionId" TEXT,
    "refereeRewardDefinitionId" TEXT,
    "minQualifyingOrderSubtotal" DECIMAL,
    "maxReferralsPerAdvocate" INTEGER,
    "fraudCheckSameIp" BOOLEAN NOT NULL DEFAULT true,
    "purchasePolicy" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyReferral" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "advocateAccountId" TEXT NOT NULL,
    "refereeShopperId" TEXT,
    "refereeAccountId" TEXT,
    "friendEmailDigest" TEXT,
    "friendRewardDefinitionId" TEXT,
    "friendShopifyDiscountCode" TEXT,
    "friendShopifyDiscountCodeCanonical" TEXT,
    "friendShopifyDiscountId" TEXT,
    "friendRewardProvisionedAt" DATETIME,
    "friendRewardEmailedAt" DATETIME,
    "friendEmailLeaseToken" TEXT,
    "friendEmailLeaseReservedAt" DATETIME,
    "friendEmailLeaseExpiresAt" DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00.000',
    "friendEmailDeliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "friendEmailLastError" TEXT,
    "friendRewardExpiresAt" DATETIME,
    "dubLinkId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "qualifyingOrderId" TEXT,
    "advocatePointsAwarded" BIGINT NOT NULL DEFAULT 0,
    "refereePointsAwarded" BIGINT NOT NULL DEFAULT 0,
    "ipHash" TEXT,
    "userAgentHash" TEXT,
    "fraudReason" TEXT,
    "fraudSignals" JSONB,
    "metadata" JSONB,
    "rewardedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyBackfillJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lookbackDays" INTEGER,
    "lookbackStartDate" DATETIME,
    "pointsPerCurrencyUnit" DECIMAL NOT NULL DEFAULT 1.0,
    "minOrderAmount" DECIMAL,
    "totalShoppersCount" INTEGER NOT NULL DEFAULT 0,
    "totalOrdersCount" INTEGER NOT NULL DEFAULT 0,
    "totalProjectedPoints" BIGINT NOT NULL DEFAULT 0,
    "processedAccountsCount" INTEGER NOT NULL DEFAULT 0,
    "totalCommittedPoints" BIGINT NOT NULL DEFAULT 0,
    "commitLeaseId" TEXT,
    "errorLog" TEXT,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyBackfillOrderSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "shopperId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderVersion" DATETIME NOT NULL,
    "orderStatus" TEXT NOT NULL,
    "orderHash" TEXT NOT NULL,
    "policyRevisionId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "eligibleSpend" BIGINT NOT NULL,
    "refundedSpend" BIGINT NOT NULL,
    "orderTotalAmount" BIGINT NOT NULL,
    "projectedPoints" BIGINT NOT NULL,
    "pointsPerCurrencyUnit" DECIMAL NOT NULL,
    "effectiveMultiplier" DECIMAL NOT NULL DEFAULT 1.0,
    "lineAllocations" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyBackfillOrderCredit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'claimed',
    "points" BIGINT NOT NULL,
    "ledgerEntryId" TEXT,
    "earnGrantId" TEXT,
    "creditedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyBackfillPreviewItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "shopperId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "eligibleSpend" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "projectedPoints" BIGINT NOT NULL DEFAULT 0,
    "committedLedgerEntryId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyImportSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "normalizedSha256" TEXT NOT NULL,
    "sourceFormat" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL DEFAULT 1,
    "rowCount" INTEGER NOT NULL,
    "totalOpeningBalance" DECIMAL NOT NULL,
    "createdByStaffId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preview',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "leaseId" TEXT,
    "leaseExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyImportRowSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "openingBalance" BIGINT NOT NULL,
    "birthdayMonth" INTEGER,
    "birthdayDay" INTEGER,
    "tierId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redactedAt" DATETIME
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyImportRowExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "ledgerEntryId" TEXT,
    "reversalLedgerEntryId" TEXT,
    "ledgerVersionBefore" INTEGER NOT NULL,
    "ledgerVersionAfter" INTEGER,
    "fieldStateBefore" JSONB,
    "fieldStateAfter" JSONB,
    "containmentCode" TEXT,
    "committedAt" DATETIME,
    "rolledBackAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticLoyaltyOutboxJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT,
    "scheduledFor" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "errorLog" JSONB,
    "lockedAt" DATETIME,
    "lockedBy" TEXT,
    "nextRetryAt" DATETIME,
    "processedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyFlowTriggerState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "triggerDefinitionId" TEXT NOT NULL,
    "shopifyStoreId" TEXT NOT NULL,
    "hasEnabledFlow" BOOLEAN NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyInstallIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticMerchantSettings" (
    "storeId" TEXT NOT NULL PRIMARY KEY,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "brandName" TEXT,
    "logoUrl" TEXT,
    "accentColor" TEXT,
    "timeZone" TEXT,
    "shopperEmailPaused" BOOLEAN NOT NULL DEFAULT false,
    "shopperDeliveryPolicy" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticReviewPrivacyBackfillAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "operatorReference" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticReviewOwnerPrivacyCoverage" (
    "storeId" TEXT NOT NULL,
    "shopperId" TEXT NOT NULL,
    "installationGeneration" TEXT,
    "state" TEXT NOT NULL,
    "keySetDigest" TEXT,
    "sourceDigest" TEXT,
    "identityCount" INTEGER NOT NULL DEFAULT 0,
    "redactedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("storeId", "shopperId")
);

-- CreateTable
CREATE TABLE "WeleticReviewOwnerPrivacyIdentity" (
    "storeId" TEXT NOT NULL,
    "shopperId" TEXT NOT NULL,
    "identityKind" TEXT NOT NULL,
    "identityKeyId" TEXT NOT NULL,
    "customerDigest" TEXT NOT NULL,

    PRIMARY KEY ("storeId", "shopperId", "identityKind", "identityKeyId")
);

-- CreateTable
CREATE TABLE "WeleticOpenReviewPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "contentDigest" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "shopifyUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticReviewSettings" (
    "storeId" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "sendAfterDays" INTEGER NOT NULL DEFAULT 7,
    "expiresAfterDays" INTEGER NOT NULL DEFAULT 30,
    "autoPublish" BOOLEAN NOT NULL DEFAULT false,
    "photoUploadsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "requestEmailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "collectionRevision" INTEGER NOT NULL DEFAULT 0,
    "reminderAfterDays" JSONB,
    "incentivePolicyRevision" INTEGER NOT NULL DEFAULT 0,
    "activeIncentivePolicyId" TEXT,
    "activatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticReviewIncentivePolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "contentDigest" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticReviewIncentiveActivation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "previousPolicyId" TEXT,
    "contentDigest" TEXT NOT NULL,
    "effectiveAt" DATETIME NOT NULL,
    "appId" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "shopifyUserId" TEXT NOT NULL,
    "merchantActionId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticReviewIncentiveClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopperId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "sourceReviewId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "awardSnapshot" JSONB NOT NULL,
    "validationSnapshot" JSONB NOT NULL,
    "recoveryDiscoveryCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticReviewIncentiveInvalidation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "shopperId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "decisionSnapshot" JSONB NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'pending',
    "cleanupId" TEXT,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticReviewOrderCancellation" (
    "storeId" TEXT NOT NULL,
    "orderExternalId" TEXT NOT NULL,
    "cancelledAt" DATETIME NOT NULL,

    PRIMARY KEY ("storeId", "orderExternalId")
);

-- CreateTable
CREATE TABLE "WeleticReviewRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "shopperId" TEXT NOT NULL,
    "incentivePolicyId" TEXT,
    "installationGeneration" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "fulfilledAt" DATETIME NOT NULL,
    "sendAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "reminderSnapshot" JSONB,
    "encryptedReminderToken" TEXT,
    "tokenHash" TEXT,
    "encryptedDeliveryToken" TEXT,
    "encryptedDeliverySnapshot" TEXT,
    "deliveryToken" TEXT,
    "deliveryReservedAt" DATETIME,
    "deliveryLeaseExpiresAt" DATETIME,
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" DATETIME,
    "submittedAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancellationReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticReviewReminder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "scheduledFor" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseExpiresAt" DATETIME,
    "encryptedDeliverySnapshot" TEXT,
    "sentAt" DATETIME,
    "settledAt" DATETIME,
    "outcomeReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticReviewRequestLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "purchasedQuantity" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticProductReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "requestId" TEXT,
    "productId" TEXT NOT NULL,
    "shopperId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "rating" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "merchantReply" TEXT,
    "verifiedPurchase" BOOLEAN NOT NULL DEFAULT false,
    "participationStatus" TEXT NOT NULL DEFAULT 'pending',
    "participationValidatedAt" DATETIME,
    "participationValidationRevision" TEXT,
    "participationContentDigest" TEXT,
    "incentivized" BOOLEAN NOT NULL DEFAULT false,
    "rewardStatus" TEXT NOT NULL DEFAULT 'pending',
    "rewardLedgerId" TEXT,
    "rewardReason" TEXT,
    "publishedAt" DATETIME,
    "moderatedAt" DATETIME,
    "moderatedByUserId" TEXT,
    "redactedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticOpenReviewSubmission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "shopperId" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "contentDigest" TEXT,
    "settingsRevision" INTEGER NOT NULL,
    "disclosureRevision" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redactedAt" DATETIME
);

-- CreateTable
CREATE TABLE "WeleticProductReviewTranslation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sourceReviewVersion" INTEGER NOT NULL,
    "sourceDigest" TEXT,
    "sourceLocale" TEXT,
    "title" TEXT,
    "body" TEXT,
    "redactedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticReviewTranslationAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "translationId" TEXT NOT NULL,
    "fromRevision" INTEGER NOT NULL,
    "toRevision" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "sourceReviewVersion" INTEGER NOT NULL,
    "appId" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "actorShopifyUserId" TEXT,
    "merchantActionId" TEXT NOT NULL,
    "staffRedactedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticReviewModerationAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorUserId" TEXT,
    "appId" TEXT,
    "installationGeneration" TEXT,
    "merchantActionId" TEXT,
    "reasonCode" TEXT NOT NULL,
    "reasonDetails" TEXT,
    "fromVersion" INTEGER NOT NULL,
    "toVersion" INTEGER NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "replyChanged" BOOLEAN NOT NULL,
    "redactedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticReviewMedia" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "requestId" TEXT,
    "reviewId" TEXT,
    "objectKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "uploadExpiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticOpenReviewMediaOwnership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "shopperId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "submissionKey" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "contentDigest" TEXT,
    "settingsRevision" INTEGER NOT NULL,
    "storageWriteState" TEXT NOT NULL DEFAULT 'not_started',
    "storageWriteToken" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redactedAt" DATETIME
);

-- CreateTable
CREATE TABLE "WeleticShopifyStaffGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "shopifyUserId" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedByShopifyUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopifyMerchantAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "shopifyUserId" TEXT NOT NULL,
    "owner" BOOLEAN NOT NULL,
    "permission" TEXT NOT NULL,
    "grantRevision" INTEGER,
    "targetShopifyUserId" TEXT,
    "changedPermissions" JSONB,
    "changedGrantRevision" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeleticShopifySubscriptionSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appId" TEXT NOT NULL,
    "partnerAppId" TEXT NOT NULL,
    "pendingInstallationId" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "shopId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unavailable',
    "planHandle" TEXT,
    "cancelAtEndOfCycle" BOOLEAN NOT NULL DEFAULT false,
    "cycleEndsAt" DATETIME,
    "verifiedAt" DATETIME,
    "validUntil" DATETIME,
    "refreshToken" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopperDeliveryReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "installationGeneration" TEXT NOT NULL,
    "producer" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "contentDigest" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'attempted',
    "capacityAt" DATETIME NOT NULL,
    "expiresAt" DATETIME,
    "retryUntil" DATETIME NOT NULL,
    "attemptedAt" DATETIME,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticShopperDeliveryIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "identityKind" TEXT NOT NULL,
    "identityKeyId" TEXT NOT NULL,
    "customerDigest" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticStoreReviewSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "requestEmailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "activatedAt" DATETIME,
    "autoPublish" BOOLEAN NOT NULL DEFAULT false,
    "sendAfterDays" INTEGER NOT NULL DEFAULT 7,
    "expiresAfterDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticStoreReviewRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopperId" TEXT NOT NULL,
    "incentivePolicyId" TEXT,
    "installationGeneration" TEXT NOT NULL,
    "settingsRevision" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "fulfilledAt" DATETIME NOT NULL,
    "sendAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "tokenHash" TEXT,
    "encryptedDeliveryToken" TEXT,
    "encryptedDeliverySnapshot" TEXT,
    "deliveryToken" TEXT,
    "deliveryLeaseExpiresAt" DATETIME,
    "deliveryReservedAt" DATETIME,
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" DATETIME,
    "submittedAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancellationReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticStoreReviewRequestLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "purchasedQuantity" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticStoreReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "shopperId" TEXT,
    "requestId" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "rating" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "merchantReply" TEXT,
    "verifiedPurchase" BOOLEAN NOT NULL DEFAULT false,
    "incentivized" BOOLEAN NOT NULL DEFAULT false,
    "participationStatus" TEXT NOT NULL DEFAULT 'pending',
    "participationValidatedAt" DATETIME,
    "participationValidationRevision" TEXT,
    "participationContentDigest" TEXT,
    "rewardStatus" TEXT NOT NULL DEFAULT 'ineligible',
    "rewardLedgerId" TEXT,
    "rewardReason" TEXT,
    "publishedAt" DATETIME,
    "moderatedAt" DATETIME,
    "redactedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WeleticStoreReviewModerationAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorUserId" TEXT,
    "appId" TEXT,
    "installationGeneration" TEXT NOT NULL,
    "merchantActionId" TEXT,
    "reasonCode" TEXT NOT NULL,
    "reasonDetails" TEXT,
    "fromVersion" INTEGER NOT NULL,
    "toVersion" INTEGER NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "replyChanged" BOOLEAN NOT NULL,
    "redactedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "name" TEXT,
    "trigger" TEXT,
    "triggerConditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "disabledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "inviteCode" TEXT,
    "defaultProduct" TEXT NOT NULL DEFAULT 'links',
    "defaultProgramId" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "planTier" INTEGER NOT NULL DEFAULT 1,
    "planPeriod" TEXT,
    "stripeId" TEXT,
    "billingCycleStart" INTEGER NOT NULL,
    "billingCycleEndsAt" DATETIME,
    "trialEndsAt" DATETIME,
    "subscriptionCanceledAt" DATETIME,
    "paymentFailedAt" DATETIME,
    "invoicePrefix" TEXT,
    "stripeConnectId" TEXT,
    "shopifyStoreId" TEXT,
    "totalLinks" INTEGER NOT NULL DEFAULT 0,
    "totalClicks" INTEGER NOT NULL DEFAULT 0,
    "usage" INTEGER NOT NULL DEFAULT 0,
    "usageLimit" INTEGER NOT NULL DEFAULT 1000,
    "linksUsage" INTEGER NOT NULL DEFAULT 0,
    "linksLimit" INTEGER NOT NULL DEFAULT 25,
    "payoutsUsage" INTEGER NOT NULL DEFAULT 0,
    "payoutsLimit" INTEGER NOT NULL DEFAULT 0,
    "payoutFee" REAL NOT NULL DEFAULT 0.05,
    "payoutFeeWaiverLimit" INTEGER NOT NULL DEFAULT 0,
    "payoutFeeWaiverUsage" INTEGER NOT NULL DEFAULT 0,
    "domainsLimit" INTEGER NOT NULL DEFAULT 3,
    "tagsLimit" INTEGER NOT NULL DEFAULT 5,
    "partnerTagsLimit" INTEGER NOT NULL DEFAULT 0,
    "foldersUsage" INTEGER NOT NULL DEFAULT 0,
    "foldersLimit" INTEGER NOT NULL DEFAULT 0,
    "partnersUsage" INTEGER NOT NULL DEFAULT 0,
    "partnersLimit" INTEGER NOT NULL DEFAULT 0,
    "groupsLimit" INTEGER NOT NULL DEFAULT 0,
    "usersLimit" INTEGER NOT NULL DEFAULT 1,
    "aiUsage" INTEGER NOT NULL DEFAULT 0,
    "aiLimit" INTEGER NOT NULL DEFAULT 10,
    "networkInvitesLimit" INTEGER NOT NULL DEFAULT 0,
    "referralLinkId" TEXT,
    "referredSignups" INTEGER NOT NULL DEFAULT 0,
    "store" JSONB,
    "siteVisitTrackingSettings" JSONB,
    "allowedHostnames" JSONB,
    "publishableKey" TEXT,
    "conversionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "webhookEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dotLinkClaimed" BOOLEAN NOT NULL DEFAULT false,
    "fastDirectDebitPayouts" BOOLEAN NOT NULL DEFAULT false,
    "ssoEmailDomain" TEXT,
    "ssoEnforcedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "usageLastChecked" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ProjectInvite" (
    "email" TEXT NOT NULL,
    "expires" DATETIME NOT NULL,
    "projectId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ProjectUsers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "role" TEXT NOT NULL DEFAULT 'member',
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspacePreferences" JSONB,
    "defaultFolderId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SentEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "projectId" TEXT
);

-- CreateIndex
CREATE INDEX "ActivityLog_resourceType_resourceId_idx" ON "ActivityLog"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "ActivityLog_userId_idx" ON "ActivityLog"("userId");

-- CreateIndex
CREATE INDEX "ProgramApplication_programId_idx" ON "ProgramApplication"("programId");

-- CreateIndex
CREATE INDEX "ProgramApplication_groupId_idx" ON "ProgramApplication"("groupId");

-- CreateIndex
CREATE INDEX "ProgramApplication_email_idx" ON "ProgramApplication"("email");

-- CreateIndex
CREATE INDEX "ProgramApplication_userId_idx" ON "ProgramApplication"("userId");

-- CreateIndex
CREATE INDEX "ProgramApplicationEvent_programId_visitedAt_idx" ON "ProgramApplicationEvent"("programId", "visitedAt");

-- CreateIndex
CREATE INDEX "ProgramApplicationEvent_programId_startedAt_idx" ON "ProgramApplicationEvent"("programId", "startedAt");

-- CreateIndex
CREATE INDEX "ProgramApplicationEvent_programId_submittedAt_idx" ON "ProgramApplicationEvent"("programId", "submittedAt");

-- CreateIndex
CREATE INDEX "ProgramApplicationEvent_programId_approvedAt_idx" ON "ProgramApplicationEvent"("programId", "approvedAt");

-- CreateIndex
CREATE INDEX "ProgramApplicationEvent_programId_country_idx" ON "ProgramApplicationEvent"("programId", "country");

-- CreateIndex
CREATE INDEX "ProgramApplicationEvent_programId_referralSource_idx" ON "ProgramApplicationEvent"("programId", "referralSource");

-- CreateIndex
CREATE INDEX "ProgramApplicationEvent_programId_referredByPartnerId_idx" ON "ProgramApplicationEvent"("programId", "referredByPartnerId");

-- CreateIndex
CREATE INDEX "ProgramApplicationEvent_referredByPartnerId_idx" ON "ProgramApplicationEvent"("referredByPartnerId");

-- CreateIndex
CREATE INDEX "ProgramApplicationEvent_programApplicationId_idx" ON "ProgramApplicationEvent"("programApplicationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramApplicationEvent_partnerId_programId_key" ON "ProgramApplicationEvent"("partnerId", "programId");

-- CreateIndex
CREATE UNIQUE INDEX "Bounty_workflowId_key" ON "Bounty"("workflowId");

-- CreateIndex
CREATE INDEX "Bounty_programId_idx" ON "Bounty"("programId");

-- CreateIndex
CREATE INDEX "BountyGroup_groupId_idx" ON "BountyGroup"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "BountyGroup_bountyId_groupId_key" ON "BountyGroup"("bountyId", "groupId");

-- CreateIndex
CREATE INDEX "BountyPartnerTag_partnerTagId_idx" ON "BountyPartnerTag"("partnerTagId");

-- CreateIndex
CREATE UNIQUE INDEX "BountyPartnerTag_bountyId_partnerTagId_key" ON "BountyPartnerTag"("bountyId", "partnerTagId");

-- CreateIndex
CREATE UNIQUE INDEX "BountySubmission_commissionId_key" ON "BountySubmission"("commissionId");

-- CreateIndex
CREATE INDEX "BountySubmission_programId_partnerId_idx" ON "BountySubmission"("programId", "partnerId");

-- CreateIndex
CREATE INDEX "BountySubmission_partnerId_idx" ON "BountySubmission"("partnerId");

-- CreateIndex
CREATE INDEX "BountySubmission_userId_idx" ON "BountySubmission"("userId");

-- CreateIndex
CREATE INDEX "BountySubmission_status_idx" ON "BountySubmission"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BountySubmission_bountyId_partnerId_periodNumber_key" ON "BountySubmission"("bountyId", "partnerId", "periodNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_workflowId_key" ON "Campaign"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_qstashMessageId_key" ON "Campaign"("qstashMessageId");

-- CreateIndex
CREATE INDEX "Campaign_programId_idx" ON "Campaign"("programId");

-- CreateIndex
CREATE INDEX "CampaignGroup_groupId_idx" ON "CampaignGroup"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignGroup_campaignId_groupId_key" ON "CampaignGroup"("campaignId", "groupId");

-- CreateIndex
CREATE INDEX "CampaignPartnerTag_partnerTagId_idx" ON "CampaignPartnerTag"("partnerTagId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignPartnerTag_campaignId_partnerTagId_key" ON "CampaignPartnerTag"("campaignId", "partnerTagId");

-- CreateIndex
CREATE INDEX "PartnerComment_programId_partnerId_idx" ON "PartnerComment"("programId", "partnerId");

-- CreateIndex
CREATE INDEX "PartnerComment_partnerId_idx" ON "PartnerComment"("partnerId");

-- CreateIndex
CREATE INDEX "PartnerComment_createdAt_idx" ON "PartnerComment"("createdAt");

-- CreateIndex
CREATE INDEX "PartnerComment_userId_idx" ON "PartnerComment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Commission_eventId_key" ON "Commission"("eventId");

-- CreateIndex
CREATE INDEX "Commission_earnings_programId_partnerId_status_idx" ON "Commission"("earnings", "programId", "partnerId", "status");

-- CreateIndex
CREATE INDEX "Commission_programId_partnerId_idx" ON "Commission"("programId", "partnerId");

-- CreateIndex
CREATE INDEX "Commission_programId_status_createdAt_amount_earnings_idx" ON "Commission"("programId", "status", "createdAt", "amount", "earnings");

-- CreateIndex
CREATE INDEX "Commission_createdAt_status_programId_earnings_idx" ON "Commission"("createdAt", "status", "programId", "earnings");

-- CreateIndex
CREATE INDEX "Commission_partnerId_customerId_type_createdAt_idx" ON "Commission"("partnerId", "customerId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "Commission_payoutId_idx" ON "Commission"("payoutId");

-- CreateIndex
CREATE INDEX "Commission_customerId_idx" ON "Commission"("customerId");

-- CreateIndex
CREATE INDEX "Commission_linkId_idx" ON "Commission"("linkId");

-- CreateIndex
CREATE INDEX "Commission_status_idx" ON "Commission"("status");

-- CreateIndex
CREATE INDEX "Commission_rewardId_idx" ON "Commission"("rewardId");

-- CreateIndex
CREATE INDEX "Commission_userId_idx" ON "Commission"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Commission_invoiceId_programId_key" ON "Commission"("invoiceId", "programId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_stripeCustomerId_key" ON "Customer"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "Customer_projectId_email_idx" ON "Customer"("projectId", "email");

-- CreateIndex
CREATE INDEX "Customer_projectId_createdAt_idx" ON "Customer"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Customer_projectId_saleAmount_idx" ON "Customer"("projectId", "saleAmount");

-- CreateIndex
CREATE INDEX "Customer_projectId_firstSaleAt_idx" ON "Customer"("projectId", "firstSaleAt");

-- CreateIndex
CREATE INDEX "Customer_projectId_subscriptionCanceledAt_idx" ON "Customer"("projectId", "subscriptionCanceledAt");

-- CreateIndex
CREATE INDEX "Customer_programId_partnerId_idx" ON "Customer"("programId", "partnerId");

-- CreateIndex
CREATE INDEX "Customer_partnerId_idx" ON "Customer"("partnerId");

-- CreateIndex
CREATE INDEX "Customer_linkId_idx" ON "Customer"("linkId");

-- CreateIndex
CREATE INDEX "Customer_country_idx" ON "Customer"("country");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_projectId_externalId_key" ON "Customer"("projectId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_projectConnectId_externalId_key" ON "Customer"("projectConnectId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Dashboard_linkId_key" ON "Dashboard"("linkId");

-- CreateIndex
CREATE UNIQUE INDEX "Dashboard_folderId_key" ON "Dashboard"("folderId");

-- CreateIndex
CREATE INDEX "Dashboard_projectId_idx" ON "Dashboard"("projectId");

-- CreateIndex
CREATE INDEX "Dashboard_userId_idx" ON "Dashboard"("userId");

-- CreateIndex
CREATE INDEX "Discount_programId_idx" ON "Discount"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountCode_linkId_key" ON "DiscountCode"("linkId");

-- CreateIndex
CREATE INDEX "DiscountCode_programId_partnerId_idx" ON "DiscountCode"("programId", "partnerId");

-- CreateIndex
CREATE INDEX "DiscountCode_discountId_idx" ON "DiscountCode"("discountId");

-- CreateIndex
CREATE INDEX "DiscountCode_partnerId_idx" ON "DiscountCode"("partnerId");

-- CreateIndex
CREATE INDEX "DiscountCode_programId_disabledAt_idx" ON "DiscountCode"("programId", "disabledAt");

-- CreateIndex
CREATE INDEX "DiscountCode_partnerId_disabledAt_idx" ON "DiscountCode"("partnerId", "disabledAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountCode_programId_code_key" ON "DiscountCode"("programId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_slug_key" ON "Domain"("slug");

-- CreateIndex
CREATE INDEX "Domain_projectId_idx" ON "Domain"("projectId");

-- CreateIndex
CREATE INDEX "Domain_lastChecked_idx" ON "Domain"("lastChecked" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "RegisteredDomain_domainId_key" ON "RegisteredDomain"("domainId");

-- CreateIndex
CREATE INDEX "RegisteredDomain_projectId_idx" ON "RegisteredDomain"("projectId");

-- CreateIndex
CREATE INDEX "RegisteredDomain_expiresAt_idx" ON "RegisteredDomain"("expiresAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "DefaultDomains_projectId_key" ON "DefaultDomains"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDomain_slug_key" ON "EmailDomain"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDomain_resendDomainId_key" ON "EmailDomain"("resendDomainId");

-- CreateIndex
CREATE INDEX "EmailDomain_lastChecked_idx" ON "EmailDomain"("lastChecked" ASC);

-- CreateIndex
CREATE INDEX "EmailDomain_programId_idx" ON "EmailDomain"("programId");

-- CreateIndex
CREATE INDEX "Folder_projectId_idx" ON "Folder"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Folder_name_projectId_key" ON "Folder"("name", "projectId");

-- CreateIndex
CREATE INDEX "FolderUser_userId_idx" ON "FolderUser"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FolderUser_folderId_userId_key" ON "FolderUser"("folderId", "userId");

-- CreateIndex
CREATE INDEX "FolderAccessRequest_userId_idx" ON "FolderAccessRequest"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FolderAccessRequest_folderId_userId_key" ON "FolderAccessRequest"("folderId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "FraudRule_programId_type_key" ON "FraudRule"("programId", "type");

-- CreateIndex
CREATE INDEX "FraudEventGroup_programId_partnerId_type_status_idx" ON "FraudEventGroup"("programId", "partnerId", "type", "status");

-- CreateIndex
CREATE INDEX "FraudEventGroup_partnerId_idx" ON "FraudEventGroup"("partnerId");

-- CreateIndex
CREATE INDEX "FraudEventGroup_userId_idx" ON "FraudEventGroup"("userId");

-- CreateIndex
CREATE INDEX "FraudEventGroup_lastEventAt_idx" ON "FraudEventGroup"("lastEventAt");

-- CreateIndex
CREATE INDEX "FraudEvent_programId_partnerId_customerId_idx" ON "FraudEvent"("programId", "partnerId", "customerId");

-- CreateIndex
CREATE INDEX "FraudEvent_fraudEventGroupId_idx" ON "FraudEvent"("fraudEventGroupId");

-- CreateIndex
CREATE INDEX "FraudEvent_partnerId_idx" ON "FraudEvent"("partnerId");

-- CreateIndex
CREATE INDEX "FraudEvent_customerId_idx" ON "FraudEvent"("customerId");

-- CreateIndex
CREATE INDEX "FraudEvent_linkId_idx" ON "FraudEvent"("linkId");

-- CreateIndex
CREATE INDEX "FraudEvent_eventId_idx" ON "FraudEvent"("eventId");

-- CreateIndex
CREATE INDEX "FraudEvent_hash_idx" ON "FraudEvent"("hash");

-- CreateIndex
CREATE INDEX "FraudEvent_sourceProgramId_idx" ON "FraudEvent"("sourceProgramId");

-- CreateIndex
CREATE INDEX "FraudAlert_partnerId_idx" ON "FraudAlert"("partnerId");

-- CreateIndex
CREATE INDEX "FraudAlert_status_idx" ON "FraudAlert"("status");

-- CreateIndex
CREATE INDEX "FraudAlert_createdAt_idx" ON "FraudAlert"("createdAt");

-- CreateIndex
CREATE INDEX "FraudAlert_programId_partnerId_idx" ON "FraudAlert"("programId", "partnerId");

-- CreateIndex
CREATE INDEX "FraudAlert_reviewedById_idx" ON "FraudAlert"("reviewedById");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerGroup_clickRewardId_key" ON "PartnerGroup"("clickRewardId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerGroup_leadRewardId_key" ON "PartnerGroup"("leadRewardId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerGroup_saleRewardId_key" ON "PartnerGroup"("saleRewardId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerGroup_referralRewardId_key" ON "PartnerGroup"("referralRewardId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerGroup_discountId_key" ON "PartnerGroup"("discountId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerGroup_workflowId_key" ON "PartnerGroup"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerGroup_utmTemplateId_key" ON "PartnerGroup"("utmTemplateId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerGroup_programId_slug_key" ON "PartnerGroup"("programId", "slug");

-- CreateIndex
CREATE INDEX "PartnerGroupDefaultLink_programId_idx" ON "PartnerGroupDefaultLink"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerGroupDefaultLink_groupId_url_key" ON "PartnerGroupDefaultLink"("groupId", "url");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_slug_key" ON "Integration"("slug");

-- CreateIndex
CREATE INDEX "Integration_projectId_idx" ON "Integration"("projectId");

-- CreateIndex
CREATE INDEX "Integration_userId_idx" ON "Integration"("userId");

-- CreateIndex
CREATE INDEX "InstalledIntegration_projectId_idx" ON "InstalledIntegration"("projectId");

-- CreateIndex
CREATE INDEX "InstalledIntegration_integrationId_idx" ON "InstalledIntegration"("integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "InstalledIntegration_userId_integrationId_projectId_key" ON "InstalledIntegration"("userId", "integrationId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE INDEX "Invoice_programId_idx" ON "Invoice"("programId");

-- CreateIndex
CREATE INDEX "Invoice_workspaceId_idx" ON "Invoice"("workspaceId");

-- CreateIndex
CREATE INDEX "_jackson_index_key_store" ON "jackson_index"("key", "storeKey");

-- CreateIndex
CREATE INDEX "_jackson_store_namespace" ON "jackson_store"("namespace");

-- CreateIndex
CREATE INDEX "_jackson_ttl_expires_at" ON "jackson_ttl"("expiresAt");

-- CreateIndex
CREATE INDEX "Job_createdAt_idx" ON "Job"("createdAt");

-- CreateIndex
CREATE INDEX "SubmittedLead_programId_partnerId_idx" ON "SubmittedLead"("programId", "partnerId");

-- CreateIndex
CREATE INDEX "SubmittedLead_partnerId_idx" ON "SubmittedLead"("partnerId");

-- CreateIndex
CREATE INDEX "SubmittedLead_customerId_idx" ON "SubmittedLead"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Link_shortLink_key" ON "Link"("shortLink");

-- CreateIndex
CREATE INDEX "Link_projectId_tenantId_idx" ON "Link"("projectId", "tenantId");

-- CreateIndex
CREATE INDEX "Link_projectId_url_idx" ON "Link"("projectId", "url");

-- CreateIndex
CREATE INDEX "Link_projectId_folderId_archived_createdAt_idx" ON "Link"("projectId", "folderId", "archived", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Link_programId_partnerId_idx" ON "Link"("programId", "partnerId");

-- CreateIndex
CREATE INDEX "Link_partnerId_idx" ON "Link"("partnerId");

-- CreateIndex
CREATE INDEX "Link_domain_createdAt_idx" ON "Link"("domain", "createdAt");

-- CreateIndex
CREATE INDEX "Link_folderId_idx" ON "Link"("folderId");

-- CreateIndex
CREATE INDEX "Link_userId_idx" ON "Link"("userId");

-- CreateIndex
CREATE INDEX "Link_partnerGroupDefaultLinkId_idx" ON "Link"("partnerGroupDefaultLinkId");

-- CreateIndex
CREATE UNIQUE INDEX "Link_domain_key_key" ON "Link"("domain", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Link_projectId_externalId_key" ON "Link"("projectId", "externalId");

-- CreateIndex
CREATE INDEX "Message_programId_partnerId_idx" ON "Message"("programId", "partnerId");

-- CreateIndex
CREATE INDEX "Message_partnerId_idx" ON "Message"("partnerId");

-- CreateIndex
CREATE INDEX "Message_senderPartnerId_idx" ON "Message"("senderPartnerId");

-- CreateIndex
CREATE INDEX "Message_senderUserId_idx" ON "Message"("senderUserId");

-- CreateIndex
CREATE INDEX "MessageAttachment_messageId_idx" ON "MessageAttachment"("messageId");

-- CreateIndex
CREATE INDEX "YearInReview_workspaceId_idx" ON "YearInReview"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerRewind_partnerId_year_key" ON "PartnerRewind"("partnerId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramCategory_programId_category_key" ON "ProgramCategory"("programId", "category");

-- CreateIndex
CREATE INDEX "ProgramSimilarity_programId_similarityScore_idx" ON "ProgramSimilarity"("programId", "similarityScore");

-- CreateIndex
CREATE INDEX "ProgramSimilarity_similarProgramId_idx" ON "ProgramSimilarity"("similarProgramId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramSimilarity_programId_similarProgramId_key" ON "ProgramSimilarity"("programId", "similarProgramId");

-- CreateIndex
CREATE INDEX "DiscoveredPartner_partnerId_idx" ON "DiscoveredPartner"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredPartner_partnerId_programId_key" ON "DiscoveredPartner"("partnerId", "programId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationEmail_emailId_key" ON "NotificationEmail"("emailId");

-- CreateIndex
CREATE INDEX "NotificationEmail_type_idx" ON "NotificationEmail"("type");

-- CreateIndex
CREATE INDEX "NotificationEmail_messageId_idx" ON "NotificationEmail"("messageId");

-- CreateIndex
CREATE INDEX "NotificationEmail_bountyId_idx" ON "NotificationEmail"("bountyId");

-- CreateIndex
CREATE INDEX "NotificationEmail_campaignId_idx" ON "NotificationEmail"("campaignId");

-- CreateIndex
CREATE INDEX "NotificationEmail_partnerId_idx" ON "NotificationEmail"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "UserNotificationPreferences_userId_key" ON "UserNotificationPreferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_projectUserId_key" ON "NotificationPreference"("projectUserId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerNotificationPreferences_partnerUserId_key" ON "PartnerNotificationPreferences"("partnerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthApp_integrationId_key" ON "OAuthApp"("integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthApp_clientId_key" ON "OAuthApp"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthCode_code_key" ON "OAuthCode"("code");

-- CreateIndex
CREATE INDEX "OAuthCode_clientId_idx" ON "OAuthCode"("clientId");

-- CreateIndex
CREATE INDEX "OAuthCode_userId_idx" ON "OAuthCode"("userId");

-- CreateIndex
CREATE INDEX "OAuthCode_projectId_idx" ON "OAuthCode"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthRefreshToken_hashedRefreshToken_key" ON "OAuthRefreshToken"("hashedRefreshToken");

-- CreateIndex
CREATE INDEX "OAuthRefreshToken_installationId_idx" ON "OAuthRefreshToken"("installationId");

-- CreateIndex
CREATE INDEX "OAuthRefreshToken_accessTokenId_idx" ON "OAuthRefreshToken"("accessTokenId");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_username_key" ON "Partner"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_email_key" ON "Partner"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_veriffSessionId_key" ON "Partner"("veriffSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_paypalEmail_key" ON "Partner"("paypalEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_stripeConnectId_key" ON "Partner"("stripeConnectId");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_stripeRecipientId_key" ON "Partner"("stripeRecipientId");

-- CreateIndex
CREATE INDEX "Partner_country_idx" ON "Partner"("country");

-- CreateIndex
CREATE INDEX "Partner_networkStatus_idx" ON "Partner"("networkStatus");

-- CreateIndex
CREATE INDEX "Partner_createdAt_idx" ON "Partner"("createdAt");

-- CreateIndex
CREATE INDEX "Partner_payoutMethodHash_idx" ON "Partner"("payoutMethodHash");

-- CreateIndex
CREATE INDEX "Partner_cryptoWalletAddress_idx" ON "Partner"("cryptoWalletAddress");

-- CreateIndex
CREATE INDEX "Partner_identityVerifiedAt_idx" ON "Partner"("identityVerifiedAt");

-- CreateIndex
CREATE INDEX "Partner_referredByPartnerId_idx" ON "Partner"("referredByPartnerId");

-- CreateIndex
CREATE INDEX "Partner_tremendousEmail_idx" ON "Partner"("tremendousEmail");

-- CreateIndex
CREATE INDEX "PartnerInvite_partnerId_idx" ON "PartnerInvite"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerInvite_email_partnerId_key" ON "PartnerInvite"("email", "partnerId");

-- CreateIndex
CREATE INDEX "PartnerUser_partnerId_idx" ON "PartnerUser"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerUser_userId_partnerId_key" ON "PartnerUser"("userId", "partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerIndustryInterest_partnerId_industryInterest_key" ON "PartnerIndustryInterest"("partnerId", "industryInterest");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerPreferredEarningStructure_partnerId_preferredEarningStructure_key" ON "PartnerPreferredEarningStructure"("partnerId", "preferredEarningStructure");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerSalesChannel_partnerId_salesChannel_key" ON "PartnerSalesChannel"("partnerId", "salesChannel");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_paypalTransferId_key" ON "Payout"("paypalTransferId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_webhookEventId_key" ON "Payout"("webhookEventId");

-- CreateIndex
CREATE INDEX "Payout_programId_status_idx" ON "Payout"("programId", "status");

-- CreateIndex
CREATE INDEX "Payout_programId_partnerId_idx" ON "Payout"("programId", "partnerId");

-- CreateIndex
CREATE INDEX "Payout_partnerId_idx" ON "Payout"("partnerId");

-- CreateIndex
CREATE INDEX "Payout_invoiceId_idx" ON "Payout"("invoiceId");

-- CreateIndex
CREATE INDEX "Payout_status_idx" ON "Payout"("status");

-- CreateIndex
CREATE INDEX "Payout_updatedAt_status_idx" ON "Payout"("updatedAt", "status");

-- CreateIndex
CREATE INDEX "Payout_method_idx" ON "Payout"("method");

-- CreateIndex
CREATE INDEX "Payout_userId_idx" ON "Payout"("userId");

-- CreateIndex
CREATE INDEX "Payout_stripePayoutId_idx" ON "Payout"("stripePayoutId");

-- CreateIndex
CREATE INDEX "Payout_stripeTransferId_idx" ON "Payout"("stripeTransferId");

-- CreateIndex
CREATE INDEX "Payout_tremendousOrderId_idx" ON "Payout"("tremendousOrderId");

-- CreateIndex
CREATE INDEX "PartnerPlatform_type_verifiedAt_lastCheckedAt_idx" ON "PartnerPlatform"("type", "verifiedAt", "lastCheckedAt");

-- CreateIndex
CREATE INDEX "PartnerPlatform_identifier_idx" ON "PartnerPlatform"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerPlatform_partnerId_type_key" ON "PartnerPlatform"("partnerId", "type");

-- CreateIndex
CREATE INDEX "Postback_partnerId_idx" ON "Postback"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "Program_slug_key" ON "Program"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Program_domain_key" ON "Program"("domain");

-- CreateIndex
CREATE INDEX "Program_workspaceId_idx" ON "Program"("workspaceId");

-- CreateIndex
CREATE INDEX "Program_addedToMarketplaceAt_idx" ON "Program"("addedToMarketplaceAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramEnrollment_applicationId_key" ON "ProgramEnrollment"("applicationId");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_programId_status_createdAt_idx" ON "ProgramEnrollment"("programId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_programId_status_totalClicks_idx" ON "ProgramEnrollment"("programId", "status", "totalClicks");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_programId_status_totalLeads_idx" ON "ProgramEnrollment"("programId", "status", "totalLeads");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_programId_status_totalConversions_idx" ON "ProgramEnrollment"("programId", "status", "totalConversions");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_programId_status_totalSaleAmount_idx" ON "ProgramEnrollment"("programId", "status", "totalSaleAmount");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_programId_status_totalCommissions_idx" ON "ProgramEnrollment"("programId", "status", "totalCommissions");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_programId_status_netRevenue_idx" ON "ProgramEnrollment"("programId", "status", "netRevenue");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_programId_status_earningsPerClick_idx" ON "ProgramEnrollment"("programId", "status", "earningsPerClick");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_programId_status_averageLifetimeValue_idx" ON "ProgramEnrollment"("programId", "status", "averageLifetimeValue");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_programId_status_clickToLeadRate_idx" ON "ProgramEnrollment"("programId", "status", "clickToLeadRate");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_programId_status_clickToConversionRate_idx" ON "ProgramEnrollment"("programId", "status", "clickToConversionRate");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_programId_status_leadToConversionRate_idx" ON "ProgramEnrollment"("programId", "status", "leadToConversionRate");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_programId_status_returnOnAdSpend_idx" ON "ProgramEnrollment"("programId", "status", "returnOnAdSpend");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_programId_groupId_idx" ON "ProgramEnrollment"("programId", "groupId");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_groupId_status_idx" ON "ProgramEnrollment"("groupId", "status");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_status_idx" ON "ProgramEnrollment"("status");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_clickRewardId_idx" ON "ProgramEnrollment"("clickRewardId");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_leadRewardId_idx" ON "ProgramEnrollment"("leadRewardId");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_saleRewardId_idx" ON "ProgramEnrollment"("saleRewardId");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_referralRewardId_idx" ON "ProgramEnrollment"("referralRewardId");

-- CreateIndex
CREATE INDEX "ProgramEnrollment_discountId_idx" ON "ProgramEnrollment"("discountId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramEnrollment_partnerId_programId_key" ON "ProgramEnrollment"("partnerId", "programId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramEnrollment_tenantId_programId_key" ON "ProgramEnrollment"("tenantId", "programId");

-- CreateIndex
CREATE INDEX "Reward_programId_event_idx" ON "Reward"("programId", "event");

-- CreateIndex
CREATE INDEX "Reward_event_idx" ON "Reward"("event");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_sentMail_idx" ON "User"("sentMail");

-- CreateIndex
CREATE INDEX "User_source_idx" ON "User"("source");

-- CreateIndex
CREATE INDEX "User_defaultWorkspace_idx" ON "User"("defaultWorkspace");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Tag_projectId_idx" ON "Tag"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_name_projectId_key" ON "Tag"("name", "projectId");

-- CreateIndex
CREATE INDEX "LinkTag_tagId_idx" ON "LinkTag"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "LinkTag_linkId_tagId_key" ON "LinkTag"("linkId", "tagId");

-- CreateIndex
CREATE INDEX "PartnerTag_programId_idx" ON "PartnerTag"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerTag_programId_name_key" ON "PartnerTag"("programId", "name");

-- CreateIndex
CREATE INDEX "ProgramPartnerTag_partnerId_idx" ON "ProgramPartnerTag"("partnerId");

-- CreateIndex
CREATE INDEX "ProgramPartnerTag_programId_partnerId_idx" ON "ProgramPartnerTag"("programId", "partnerId");

-- CreateIndex
CREATE INDEX "ProgramPartnerTag_partnerTagId_programId_idx" ON "ProgramPartnerTag"("partnerTagId", "programId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramPartnerTag_partnerTagId_partnerId_key" ON "ProgramPartnerTag"("partnerTagId", "partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "Token_hashedKey_key" ON "Token"("hashedKey");

-- CreateIndex
CREATE INDEX "Token_userId_idx" ON "Token"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RestrictedToken_hashedKey_key" ON "RestrictedToken"("hashedKey");

-- CreateIndex
CREATE INDEX "RestrictedToken_userId_idx" ON "RestrictedToken"("userId");

-- CreateIndex
CREATE INDEX "RestrictedToken_projectId_idx" ON "RestrictedToken"("projectId");

-- CreateIndex
CREATE INDEX "RestrictedToken_installationId_idx" ON "RestrictedToken"("installationId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_token_key" ON "EmailVerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_identifier_token_key" ON "EmailVerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_token_key" ON "PasswordResetToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_identifier_token_key" ON "PasswordResetToken"("identifier", "token");

-- CreateIndex
CREATE INDEX "UtmTemplate_userId_idx" ON "UtmTemplate"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UtmTemplate_projectId_name_key" ON "UtmTemplate"("projectId", "name");

-- CreateIndex
CREATE INDEX "Webhook_projectId_idx" ON "Webhook"("projectId");

-- CreateIndex
CREATE INDEX "Webhook_installationId_idx" ON "Webhook"("installationId");

-- CreateIndex
CREATE INDEX "LinkWebhook_webhookId_idx" ON "LinkWebhook"("webhookId");

-- CreateIndex
CREATE UNIQUE INDEX "LinkWebhook_linkId_webhookId_key" ON "LinkWebhook"("linkId", "webhookId");

-- CreateIndex
CREATE INDEX "FolderWebhook_webhookId_idx" ON "FolderWebhook"("webhookId");

-- CreateIndex
CREATE UNIQUE INDEX "FolderWebhook_folderId_webhookId_key" ON "FolderWebhook"("folderId", "webhookId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyStore_projectId_key" ON "WeleticShopifyStore"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyStore_programId_key" ON "WeleticShopifyStore"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyStore_shopDomain_key" ON "WeleticShopifyStore"("shopDomain");

-- CreateIndex
CREATE INDEX "WeleticShopifyStore_syncStatus_idx" ON "WeleticShopifyStore"("syncStatus");

-- CreateIndex
CREATE INDEX "WeleticShopifyStore_complianceState_idx" ON "WeleticShopifyStore"("complianceState");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_store_app_credential_key" ON "WeleticShopifyInstallationCredential"("storeId", "appId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyStoreAccessChange_storeId_revision_key" ON "WeleticShopifyStoreAccessChange"("storeId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyPendingInstallation_mappedStoreId_key" ON "WeleticShopifyPendingInstallation"("mappedStoreId");

-- CreateIndex
CREATE INDEX "WeleticShopifyPendingInstallation_state_expiresAt_idx" ON "WeleticShopifyPendingInstallation"("state", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "pending_installation_identity_key" ON "WeleticShopifyPendingInstallation"("appId", "identityKeyId", "shopDomainDigest");

-- CreateIndex
CREATE UNIQUE INDEX "pending_installation_audit_revision_key" ON "WeleticShopifyPendingInstallationChange"("pendingInstallationId", "revision");

-- CreateIndex
CREATE INDEX "WeleticShopifyAppSession_shop_idx" ON "WeleticShopifyAppSession"("shop");

-- CreateIndex
CREATE INDEX "WeleticShopifyAppSession_expiresAt_idx" ON "WeleticShopifyAppSession"("expiresAt");

-- CreateIndex
CREATE INDEX "WeleticShopifySessionCoordination_shop_idx" ON "WeleticShopifySessionCoordination"("shop");

-- CreateIndex
CREATE INDEX "WeleticShopifySessionCoordination_leaseExpiresAt_idx" ON "WeleticShopifySessionCoordination"("leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifySessionCoordination_appId_shop_key" ON "WeleticShopifySessionCoordination"("appId", "shop");

-- CreateIndex
CREATE INDEX "WeleticShopifyMarket_storeId_enabled_idx" ON "WeleticShopifyMarket"("storeId", "enabled");

-- CreateIndex
CREATE INDEX "WeleticShopifyMarket_storeId_updatedAt_idx" ON "WeleticShopifyMarket"("storeId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyMarket_storeId_externalId_key" ON "WeleticShopifyMarket"("storeId", "externalId");

-- CreateIndex
CREATE INDEX "WeleticShopifyProduct_programId_status_availableForSale_idx" ON "WeleticShopifyProduct"("programId", "status", "availableForSale");

-- CreateIndex
CREATE INDEX "WeleticShopifyProduct_storeId_updatedAt_idx" ON "WeleticShopifyProduct"("storeId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyProduct_storeId_externalId_key" ON "WeleticShopifyProduct"("storeId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyProduct_storeId_handle_key" ON "WeleticShopifyProduct"("storeId", "handle");

-- CreateIndex
CREATE INDEX "WeleticShopifyVariant_productId_availableForSale_idx" ON "WeleticShopifyVariant"("productId", "availableForSale");

-- CreateIndex
CREATE INDEX "WeleticShopifyVariant_productId_updatedAt_idx" ON "WeleticShopifyVariant"("productId", "updatedAt");

-- CreateIndex
CREATE INDEX "WeleticShopifyVariant_externalId_idx" ON "WeleticShopifyVariant"("externalId");

-- CreateIndex
CREATE INDEX "WeleticShopifyVariant_sku_idx" ON "WeleticShopifyVariant"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyVariant_productId_externalId_key" ON "WeleticShopifyVariant"("productId", "externalId");

-- CreateIndex
CREATE INDEX "WeleticShopifyTranslation_marketId_locale_idx" ON "WeleticShopifyTranslation"("marketId", "locale");

-- CreateIndex
CREATE INDEX "WeleticShopifyTranslation_productId_updatedAt_idx" ON "WeleticShopifyTranslation"("productId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyTranslation_productId_locale_marketKey_key" ON "WeleticShopifyTranslation"("productId", "locale", "marketKey");

-- CreateIndex
CREATE INDEX "WeleticShopifyMarketPrice_marketId_countryCode_available_idx" ON "WeleticShopifyMarketPrice"("marketId", "countryCode", "available");

-- CreateIndex
CREATE INDEX "WeleticShopifyMarketPrice_marketId_countryCode_updatedAt_idx" ON "WeleticShopifyMarketPrice"("marketId", "countryCode", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyMarketPrice_variantId_marketId_countryCode_key" ON "WeleticShopifyMarketPrice"("variantId", "marketId", "countryCode");

-- CreateIndex
CREATE INDEX "WeleticShopifySyncRun_storeId_status_createdAt_idx" ON "WeleticShopifySyncRun"("storeId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyWebhookEvent_webhookId_key" ON "WeleticShopifyWebhookEvent"("webhookId");

-- CreateIndex
CREATE INDEX "WeleticShopifyWebhookEvent_storeId_topic_createdAt_idx" ON "WeleticShopifyWebhookEvent"("storeId", "topic", "createdAt");

-- CreateIndex
CREATE INDEX "WeleticShopifyWebhookEvent_status_createdAt_idx" ON "WeleticShopifyWebhookEvent"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticProductLink_linkId_key" ON "WeleticProductLink"("linkId");

-- CreateIndex
CREATE INDEX "WeleticProductLink_programId_partnerId_createdAt_idx" ON "WeleticProductLink"("programId", "partnerId", "createdAt");

-- CreateIndex
CREATE INDEX "WeleticProductLink_productId_marketId_idx" ON "WeleticProductLink"("productId", "marketId");

-- CreateIndex
CREATE INDEX "WeleticProductLink_partnerId_idx" ON "WeleticProductLink"("partnerId");

-- CreateIndex
CREATE INDEX "WeleticProductLink_variantId_idx" ON "WeleticProductLink"("variantId");

-- CreateIndex
CREATE INDEX "WeleticProductLink_marketId_idx" ON "WeleticProductLink"("marketId");

-- CreateIndex
CREATE INDEX "WeleticFxRateSnapshot_base_quote_capturedAt_idx" ON "WeleticFxRateSnapshot"("base", "quote", "capturedAt");

-- CreateIndex
CREATE INDEX "WeleticCommerceOrder_storeId_occurredAt_idx" ON "WeleticCommerceOrder"("storeId", "occurredAt");

-- CreateIndex
CREATE INDEX "WeleticCommerceOrder_programId_partnerId_occurredAt_idx" ON "WeleticCommerceOrder"("programId", "partnerId", "occurredAt");

-- CreateIndex
CREATE INDEX "WeleticCommerceOrder_status_occurredAt_idx" ON "WeleticCommerceOrder"("status", "occurredAt");

-- CreateIndex
CREATE INDEX "WeleticCommerceOrder_partnerId_idx" ON "WeleticCommerceOrder"("partnerId");

-- CreateIndex
CREATE INDEX "WeleticCommerceOrder_linkId_idx" ON "WeleticCommerceOrder"("linkId");

-- CreateIndex
CREATE INDEX "WeleticCommerceOrder_shopperId_idx" ON "WeleticCommerceOrder"("shopperId");

-- CreateIndex
CREATE INDEX "WeleticCommerceOrder_marketId_idx" ON "WeleticCommerceOrder"("marketId");

-- CreateIndex
CREATE INDEX "WeleticCommerceOrder_fxRateSnapshotId_idx" ON "WeleticCommerceOrder"("fxRateSnapshotId");

-- CreateIndex
CREATE INDEX "WeleticCommerceOrder_loyaltyPolicyRevisionId_idx" ON "WeleticCommerceOrder"("loyaltyPolicyRevisionId");

-- CreateIndex
CREATE INDEX "WeleticCommerceOrder_storeId_loyaltyPolicyRevisionId_idx" ON "WeleticCommerceOrder"("storeId", "loyaltyPolicyRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticCommerceOrder_storeId_externalId_key" ON "WeleticCommerceOrder"("storeId", "externalId");

-- CreateIndex
CREATE INDEX "WeleticCommerceOrderLine_productId_idx" ON "WeleticCommerceOrderLine"("productId");

-- CreateIndex
CREATE INDEX "WeleticCommerceOrderLine_variantId_idx" ON "WeleticCommerceOrderLine"("variantId");

-- CreateIndex
CREATE INDEX "WeleticCommerceOrderLine_sellingPlanId_idx" ON "WeleticCommerceOrderLine"("sellingPlanId");

-- CreateIndex
CREATE INDEX "WeleticCommerceOrderLine_subscriptionSeriesKey_idx" ON "WeleticCommerceOrderLine"("subscriptionSeriesKey");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticCommerceOrderLine_orderId_externalId_key" ON "WeleticCommerceOrderLine"("orderId", "externalId");

-- CreateIndex
CREATE INDEX "WeleticCommerceRefund_orderId_occurredAt_idx" ON "WeleticCommerceRefund"("orderId", "occurredAt");

-- CreateIndex
CREATE INDEX "WeleticCommerceRefund_fxRateSnapshotId_idx" ON "WeleticCommerceRefund"("fxRateSnapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticCommerceRefund_storeId_externalId_key" ON "WeleticCommerceRefund"("storeId", "externalId");

-- CreateIndex
CREATE INDEX "WeleticCommerceRefundLine_orderLineId_idx" ON "WeleticCommerceRefundLine"("orderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticCommerceRefundLine_refundId_externalId_key" ON "WeleticCommerceRefundLine"("refundId", "externalId");

-- CreateIndex
CREATE INDEX "WeleticCommissionRule_programId_active_effectiveAt_expiresAt_idx" ON "WeleticCommissionRule"("programId", "active", "effectiveAt", "expiresAt");

-- CreateIndex
CREATE INDEX "WeleticCommissionRule_productId_variantId_idx" ON "WeleticCommissionRule"("productId", "variantId");

-- CreateIndex
CREATE INDEX "WeleticCommissionRule_collectionExternalId_promotionCode_idx" ON "WeleticCommissionRule"("collectionExternalId", "promotionCode");

-- CreateIndex
CREATE INDEX "WeleticCommissionRule_variantId_idx" ON "WeleticCommissionRule"("variantId");

-- CreateIndex
CREATE INDEX "WeleticCommissionRule_partnerId_idx" ON "WeleticCommissionRule"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticCommissionRule_programId_logicalKey_version_key" ON "WeleticCommissionRule"("programId", "logicalKey", "version");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticCommissionCalculation_sourceKey_key" ON "WeleticCommissionCalculation"("sourceKey");

-- CreateIndex
CREATE INDEX "WeleticCommissionCalculation_orderLineId_idx" ON "WeleticCommissionCalculation"("orderLineId");

-- CreateIndex
CREATE INDEX "WeleticCommissionCalculation_refundLineId_idx" ON "WeleticCommissionCalculation"("refundLineId");

-- CreateIndex
CREATE INDEX "WeleticCommissionCalculation_commissionId_idx" ON "WeleticCommissionCalculation"("commissionId");

-- CreateIndex
CREATE INDEX "WeleticCommissionCalculation_ruleId_idx" ON "WeleticCommissionCalculation"("ruleId");

-- CreateIndex
CREATE INDEX "WeleticCommissionCalculation_entryType_createdAt_idx" ON "WeleticCommissionCalculation"("entryType", "createdAt");

-- CreateIndex
CREATE INDEX "WeleticPayoutProfile_partnerId_status_idx" ON "WeleticPayoutProfile"("partnerId", "status");

-- CreateIndex
CREATE INDEX "WeleticPayoutProfile_programId_status_idx" ON "WeleticPayoutProfile"("programId", "status");

-- CreateIndex
CREATE INDEX "WeleticPayoutProfile_verifiedByUserId_idx" ON "WeleticPayoutProfile"("verifiedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticPayoutProfile_partnerId_programId_payoutCurrency_provider_key" ON "WeleticPayoutProfile"("partnerId", "programId", "payoutCurrency", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticPayoutQuote_payoutId_key" ON "WeleticPayoutQuote"("payoutId");

-- CreateIndex
CREATE INDEX "WeleticPayoutQuote_provider_quotedAt_idx" ON "WeleticPayoutQuote"("provider", "quotedAt");

-- CreateIndex
CREATE INDEX "WeleticPayoutQuote_payoutProfileId_idx" ON "WeleticPayoutQuote"("payoutProfileId");

-- CreateIndex
CREATE INDEX "WeleticPayoutQuote_fxRateSnapshotId_idx" ON "WeleticPayoutQuote"("fxRateSnapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticPayoutStatement_payoutId_key" ON "WeleticPayoutStatement"("payoutId");

-- CreateIndex
CREATE INDEX "WeleticReconciliationIssue_storeId_status_severity_idx" ON "WeleticReconciliationIssue"("storeId", "status", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticReconciliationIssue_storeId_kind_externalKey_key" ON "WeleticReconciliationIssue"("storeId", "kind", "externalKey");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyComplianceRequest_webhookId_key" ON "WeleticShopifyComplianceRequest"("webhookId");

-- CreateIndex
CREATE INDEX "WeleticShopifyComplianceRequest_status_nextRetryAt_idx" ON "WeleticShopifyComplianceRequest"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "WeleticShopifyComplianceRequest_storeId_requestType_status_idx" ON "WeleticShopifyComplianceRequest"("storeId", "requestType", "status");

-- CreateIndex
CREATE INDEX "WeleticShopifyComplianceRequest_lockedAt_idx" ON "WeleticShopifyComplianceRequest"("lockedAt");

-- CreateIndex
CREATE INDEX "WeleticShopifyComplianceRequest_createdAt_idx" ON "WeleticShopifyComplianceRequest"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyComplianceRequest_storeId_id_key" ON "WeleticShopifyComplianceRequest"("storeId", "id");

-- CreateIndex
CREATE INDEX "WeleticShopifyComplianceArtifact_storeId_expiresAt_idx" ON "WeleticShopifyComplianceArtifact"("storeId", "expiresAt");

-- CreateIndex
CREATE INDEX "WeleticShopifyComplianceArtifact_expiresAt_deletedAt_idx" ON "WeleticShopifyComplianceArtifact"("expiresAt", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyComplianceArtifact_requestId_kind_sequence_key" ON "WeleticShopifyComplianceArtifact"("requestId", "kind", "sequence");

-- CreateIndex
CREATE INDEX "WeleticShopifyCustomerPrivacyTombstone_storeId_expiresAt_idx" ON "WeleticShopifyCustomerPrivacyTombstone"("storeId", "expiresAt");

-- CreateIndex
CREATE INDEX "WeleticShopifyCustomerPrivacyTombstone_storeId_shopperId_idx" ON "WeleticShopifyCustomerPrivacyTombstone"("storeId", "shopperId");

-- CreateIndex
CREATE INDEX "WeleticShopifyCustomerPrivacyTombstone_storeId_accountId_idx" ON "WeleticShopifyCustomerPrivacyTombstone"("storeId", "accountId");

-- CreateIndex
CREATE INDEX "WeleticShopifyCustomerPrivacyTombstone_sourceRequestId_idx" ON "WeleticShopifyCustomerPrivacyTombstone"("sourceRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyCustomerPrivacyTombstone_storeId_identityKind_identityKeyId_customerDigest_key" ON "WeleticShopifyCustomerPrivacyTombstone"("storeId", "identityKind", "identityKeyId", "customerDigest");

-- CreateIndex
CREATE INDEX "WeleticShopifyShopPrivacyTombstone_storeId_expiresAt_idx" ON "WeleticShopifyShopPrivacyTombstone"("storeId", "expiresAt");

-- CreateIndex
CREATE INDEX "WeleticShopifyShopPrivacyTombstone_sourceRequestId_idx" ON "WeleticShopifyShopPrivacyTombstone"("sourceRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyShopPrivacyTombstone_identityKeyId_shopDomainDigest_key" ON "WeleticShopifyShopPrivacyTombstone"("identityKeyId", "shopDomainDigest");

-- CreateIndex
CREATE INDEX "WeleticShopifyVoucherCleanup_status_nextRetryAt_idx" ON "WeleticShopifyVoucherCleanup"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "WeleticShopifyVoucherCleanup_storeId_status_idx" ON "WeleticShopifyVoucherCleanup"("storeId", "status");

-- CreateIndex
CREATE INDEX "WeleticShopifyVoucherCleanup_lockedAt_idx" ON "WeleticShopifyVoucherCleanup"("lockedAt");

-- CreateIndex
CREATE INDEX "WeleticShopifyVoucherCleanup_sourceRequestId_idx" ON "WeleticShopifyVoucherCleanup"("sourceRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyVoucherCleanup_storeId_redemptionId_key" ON "WeleticShopifyVoucherCleanup"("storeId", "redemptionId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyVoucherCleanup_storeId_id_key" ON "WeleticShopifyVoucherCleanup"("storeId", "id");

-- CreateIndex
CREATE INDEX "WeleticShopifyVoucherCleanupRequestLink_storeId_requestId_idx" ON "WeleticShopifyVoucherCleanupRequestLink"("storeId", "requestId");

-- CreateIndex
CREATE INDEX "WeleticShopifyVoucherCleanupRequestLink_storeId_cleanupId_idx" ON "WeleticShopifyVoucherCleanupRequestLink"("storeId", "cleanupId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyVoucherCleanupRequestLink_requestId_cleanupId_key" ON "WeleticShopifyVoucherCleanupRequestLink"("requestId", "cleanupId");

-- CreateIndex
CREATE UNIQUE INDEX "flow_grant_approval_action" ON "WeleticShopifyFlowPointsGrant"("approvedMerchantActionId");

-- CreateIndex
CREATE UNIQUE INDEX "flow_grant_revocation_action" ON "WeleticShopifyFlowPointsGrant"("revokedMerchantActionId");

-- CreateIndex
CREATE INDEX "flow_grant_store_generation" ON "WeleticShopifyFlowPointsGrant"("storeId", "appId", "installationGeneration", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "flow_action_ledger_receipt" ON "WeleticShopifyFlowActionRun"("ledgerEntryId");

-- CreateIndex
CREATE INDEX "flow_action_audit_history" ON "WeleticShopifyFlowActionRun"("storeId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "flow_action_grant" ON "WeleticShopifyFlowActionRun"("grantId");

-- CreateIndex
CREATE UNIQUE INDEX "flow_action_durable_run" ON "WeleticShopifyFlowActionRun"("storeId", "appId", "runKey");

-- CreateIndex
CREATE INDEX "WeleticShopper_storeId_email_idx" ON "WeleticShopper"("storeId", "email");

-- CreateIndex
CREATE INDEX "WeleticShopper_storeId_updatedAt_idx" ON "WeleticShopper"("storeId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopper_storeId_id_key" ON "WeleticShopper"("storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopper_storeId_shopifyCustomerId_key" ON "WeleticShopper"("storeId", "shopifyCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyProgram_storeId_key" ON "WeleticLoyaltyProgram"("storeId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyProgram_status_idx" ON "WeleticLoyaltyProgram"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyProgram_storeId_id_key" ON "WeleticLoyaltyProgram"("storeId", "id");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyBonusCampaign_programId_isActive_idx" ON "WeleticLoyaltyBonusCampaign"("programId", "isActive");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyBonusCampaign_programId_startAt_endAt_idx" ON "WeleticLoyaltyBonusCampaign"("programId", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyBonusCampaign_programId_deletedAt_isActive_startAt_endAt_idx" ON "WeleticLoyaltyBonusCampaign"("programId", "deletedAt", "isActive", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyEarningRule_programId_isActive_idx" ON "WeleticLoyaltyEarningRule"("programId", "isActive");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyEarningRule_programId_triggerCode_isActive_idx" ON "WeleticLoyaltyEarningRule"("programId", "triggerCode", "isActive");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyEarningRule_programId_priority_idx" ON "WeleticLoyaltyEarningRule"("programId", "priority");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyEarningRule_programId_deletedAt_priority_idx" ON "WeleticLoyaltyEarningRule"("programId", "deletedAt", "priority");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyReviewIntegration_provider_enabled_idx" ON "WeleticLoyaltyReviewIntegration"("provider", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyReviewIntegration_storeId_provider_key" ON "WeleticLoyaltyReviewIntegration"("storeId", "provider");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyTier_programId_tierOrder_idx" ON "WeleticLoyaltyTier"("programId", "tierOrder");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyTier_programId_deletedAt_tierOrder_idx" ON "WeleticLoyaltyTier"("programId", "deletedAt", "tierOrder");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyTier_programId_slug_key" ON "WeleticLoyaltyTier"("programId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyTier_programId_tierOrder_key" ON "WeleticLoyaltyTier"("programId", "tierOrder");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyEarnPolicyRevision_programId_effectiveAt_version_idx" ON "WeleticLoyaltyEarnPolicyRevision"("programId", "effectiveAt", "version");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyEarnPolicyRevision_storeId_effectiveAt_idx" ON "WeleticLoyaltyEarnPolicyRevision"("storeId", "effectiveAt");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyEarnPolicyRevision_programId_fingerprint_idx" ON "WeleticLoyaltyEarnPolicyRevision"("programId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyEarnPolicyRevision_programId_version_key" ON "WeleticLoyaltyEarnPolicyRevision"("programId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyEarnPolicyRevision_storeId_id_key" ON "WeleticLoyaltyEarnPolicyRevision"("storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyEarnPolicyRevision_storeId_programId_id_key" ON "WeleticLoyaltyEarnPolicyRevision"("storeId", "programId", "id");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyTierHistory_accountId_effectiveAt_sequenceNumber_idx" ON "WeleticLoyaltyTierHistory"("accountId", "effectiveAt", "sequenceNumber");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyTierHistory_toTierId_idx" ON "WeleticLoyaltyTierHistory"("toTierId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyTierHistory_fromTierId_idx" ON "WeleticLoyaltyTierHistory"("fromTierId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyTierHistory_accountId_sequenceNumber_key" ON "WeleticLoyaltyTierHistory"("accountId", "sequenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyAccount_shopperId_key" ON "WeleticLoyaltyAccount"("shopperId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyAccount_referralCode_key" ON "WeleticLoyaltyAccount"("referralCode");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyAccount_storeId_status_idx" ON "WeleticLoyaltyAccount"("storeId", "status");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyAccount_storeId_enrolledAt_idx" ON "WeleticLoyaltyAccount"("storeId", "enrolledAt");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyAccount_programId_status_idx" ON "WeleticLoyaltyAccount"("programId", "status");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyAccount_storeId_referralCode_idx" ON "WeleticLoyaltyAccount"("storeId", "referralCode");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyAccount_referredById_idx" ON "WeleticLoyaltyAccount"("referredById");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyAccount_currentTierId_idx" ON "WeleticLoyaltyAccount"("currentTierId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyAccount_storeId_nextExpiryDate_idx" ON "WeleticLoyaltyAccount"("storeId", "nextExpiryDate");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyAccount_storeId_id_key" ON "WeleticLoyaltyAccount"("storeId", "id");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyEarnGrant_accountId_status_idx" ON "WeleticLoyaltyEarnGrant"("accountId", "status");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyEarnGrant_storeId_status_availableAt_idx" ON "WeleticLoyaltyEarnGrant"("storeId", "status", "availableAt");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyEarnGrant_orderId_idx" ON "WeleticLoyaltyEarnGrant"("orderId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyEarnGrant_policyRevisionId_idx" ON "WeleticLoyaltyEarnGrant"("policyRevisionId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyEarnGrant_storeId_programId_policyRevisionId_idx" ON "WeleticLoyaltyEarnGrant"("storeId", "programId", "policyRevisionId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyEarnGrant_createdAt_idx" ON "WeleticLoyaltyEarnGrant"("createdAt");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyEarnGrant_shopperId_idx" ON "WeleticLoyaltyEarnGrant"("shopperId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyEarnGrant_programId_status_idx" ON "WeleticLoyaltyEarnGrant"("programId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyEarnGrant_storeId_orderId_key" ON "WeleticLoyaltyEarnGrant"("storeId", "orderId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyOrderLineEarn_orderLineId_idx" ON "WeleticLoyaltyOrderLineEarn"("orderLineId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyOrderLineEarn_productId_variantId_idx" ON "WeleticLoyaltyOrderLineEarn"("productId", "variantId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyOrderLineEarn_storeId_createdAt_idx" ON "WeleticLoyaltyOrderLineEarn"("storeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyOrderLineEarn_grantId_orderLineId_key" ON "WeleticLoyaltyOrderLineEarn"("grantId", "orderLineId");

-- CreateIndex
CREATE INDEX "WeleticPointsLedgerEntry_storeId_createdAt_idx" ON "WeleticPointsLedgerEntry"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "WeleticPointsLedgerEntry_accountId_createdAt_idx" ON "WeleticPointsLedgerEntry"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "WeleticPointsLedgerEntry_referenceType_referenceId_idx" ON "WeleticPointsLedgerEntry"("referenceType", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticPointsLedgerEntry_accountId_sequenceNumber_key" ON "WeleticPointsLedgerEntry"("accountId", "sequenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticPointsLedgerEntry_storeId_idempotencyKey_key" ON "WeleticPointsLedgerEntry"("storeId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "WeleticRewardDefinition_storeId_status_idx" ON "WeleticRewardDefinition"("storeId", "status");

-- CreateIndex
CREATE INDEX "wl_reward_shopper_history_idx" ON "WeleticRewardRedemption"("storeId", "shopperId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "WeleticRewardRedemption_accountId_status_idx" ON "WeleticRewardRedemption"("accountId", "status");

-- CreateIndex
CREATE INDEX "WeleticRewardRedemption_storeId_shopifyDiscountCode_idx" ON "WeleticRewardRedemption"("storeId", "shopifyDiscountCode");

-- CreateIndex
CREATE INDEX "WeleticRewardRedemption_storeId_status_idx" ON "WeleticRewardRedemption"("storeId", "status");

-- CreateIndex
CREATE INDEX "WeleticRewardRedemption_storeId_createdAt_idx" ON "WeleticRewardRedemption"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "WeleticRewardRedemption_storeId_issuanceConfirmedAt_idx" ON "WeleticRewardRedemption"("storeId", "issuanceConfirmedAt");

-- CreateIndex
CREATE INDEX "WeleticRewardRedemption_rewardDefinitionId_idx" ON "WeleticRewardRedemption"("rewardDefinitionId");

-- CreateIndex
CREATE UNIQUE INDEX "wl_reward_store_id_uq" ON "WeleticRewardRedemption"("storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "wl_redemption_store_code_canonical_uq" ON "WeleticRewardRedemption"("storeId", "shopifyDiscountCodeCanonical");

-- CreateIndex
CREATE UNIQUE INDEX "wl_redemption_store_gift_card_uq" ON "WeleticRewardRedemption"("storeId", "shopifyGiftCardId");

-- CreateIndex
CREATE UNIQUE INDEX "wl_redemption_store_credit_tx_uq" ON "WeleticRewardRedemption"("storeId", "shopifyStoreCreditTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticRewardRedemption_storeId_idempotencyKey_key" ON "WeleticRewardRedemption"("storeId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "wl_reward_fulfillment_source_uq" ON "WeleticRewardRedemption"("storeId", "fulfillmentSource", "fulfillmentReference");

-- CreateIndex
CREATE INDEX "wl_coupon_use_shopper_idx" ON "WeleticRewardCouponUse"("storeId", "shopperId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "wl_coupon_use_order_idx" ON "WeleticRewardCouponUse"("storeId", "orderExternalId");

-- CreateIndex
CREATE INDEX "wl_coupon_use_store_id_idx" ON "WeleticRewardCouponUse"("storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "wl_coupon_use_order_uq" ON "WeleticRewardCouponUse"("storeId", "redemptionId", "orderExternalId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyReferralRule_programId_isActive_idx" ON "WeleticLoyaltyReferralRule"("programId", "isActive");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyReferral_storeId_status_idx" ON "WeleticLoyaltyReferral"("storeId", "status");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyReferral_advocateAccountId_status_idx" ON "WeleticLoyaltyReferral"("advocateAccountId", "status");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyReferral_refereeAccountId_idx" ON "WeleticLoyaltyReferral"("refereeAccountId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyReferral_friendRewardDefinitionId_idx" ON "WeleticLoyaltyReferral"("friendRewardDefinitionId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyReferral_dubLinkId_idx" ON "WeleticLoyaltyReferral"("dubLinkId");

-- CreateIndex
CREATE INDEX "wl_referral_email_lease_idx" ON "WeleticLoyaltyReferral"("storeId", "friendEmailLeaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyReferral_advocateAccountId_refereeAccountId_key" ON "WeleticLoyaltyReferral"("advocateAccountId", "refereeAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "wl_referral_store_friend_email_uq" ON "WeleticLoyaltyReferral"("storeId", "friendEmailDigest");

-- CreateIndex
CREATE UNIQUE INDEX "wl_referral_store_friend_code_uq" ON "WeleticLoyaltyReferral"("storeId", "friendShopifyDiscountCodeCanonical");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyBackfillJob_storeId_status_idx" ON "WeleticLoyaltyBackfillJob"("storeId", "status");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyBackfillJob_programId_status_idx" ON "WeleticLoyaltyBackfillJob"("programId", "status");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyBackfillOrderSnapshot_storeId_orderId_idx" ON "WeleticLoyaltyBackfillOrderSnapshot"("storeId", "orderId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyBackfillOrderSnapshot_jobId_accountId_idx" ON "WeleticLoyaltyBackfillOrderSnapshot"("jobId", "accountId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyBackfillOrderSnapshot_shopperId_idx" ON "WeleticLoyaltyBackfillOrderSnapshot"("shopperId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyBackfillOrderSnapshot_jobId_orderId_key" ON "WeleticLoyaltyBackfillOrderSnapshot"("jobId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyBackfillOrderCredit_snapshotId_key" ON "WeleticLoyaltyBackfillOrderCredit"("snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyBackfillOrderCredit_ledgerEntryId_key" ON "WeleticLoyaltyBackfillOrderCredit"("ledgerEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyBackfillOrderCredit_earnGrantId_key" ON "WeleticLoyaltyBackfillOrderCredit"("earnGrantId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyBackfillOrderCredit_jobId_status_idx" ON "WeleticLoyaltyBackfillOrderCredit"("jobId", "status");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyBackfillOrderCredit_accountId_createdAt_idx" ON "WeleticLoyaltyBackfillOrderCredit"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyBackfillOrderCredit_storeId_orderId_key" ON "WeleticLoyaltyBackfillOrderCredit"("storeId", "orderId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyBackfillPreviewItem_jobId_shopperId_idx" ON "WeleticLoyaltyBackfillPreviewItem"("jobId", "shopperId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyBackfillPreviewItem_accountId_idx" ON "WeleticLoyaltyBackfillPreviewItem"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyBackfillPreviewItem_jobId_accountId_key" ON "WeleticLoyaltyBackfillPreviewItem"("jobId", "accountId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyImportSource_storeId_createdAt_id_idx" ON "WeleticLoyaltyImportSource"("storeId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyImportSource_storeId_status_createdAt_idx" ON "WeleticLoyaltyImportSource"("storeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyImportSource_status_leaseExpiresAt_idx" ON "WeleticLoyaltyImportSource"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyImportSource_storeId_programId_normalizedSha256_key" ON "WeleticLoyaltyImportSource"("storeId", "programId", "normalizedSha256");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyImportRowSnapshot_storeId_shopifyCustomerId_idx" ON "WeleticLoyaltyImportRowSnapshot"("storeId", "shopifyCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyImportRowSnapshot_sourceId_rowNumber_key" ON "WeleticLoyaltyImportRowSnapshot"("sourceId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyImportRowSnapshot_sourceId_shopifyCustomerId_key" ON "WeleticLoyaltyImportRowSnapshot"("sourceId", "shopifyCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyImportRowExecution_snapshotId_key" ON "WeleticLoyaltyImportRowExecution"("snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyImportRowExecution_ledgerEntryId_key" ON "WeleticLoyaltyImportRowExecution"("ledgerEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyImportRowExecution_reversalLedgerEntryId_key" ON "WeleticLoyaltyImportRowExecution"("reversalLedgerEntryId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyImportRowExecution_storeId_accountId_idx" ON "WeleticLoyaltyImportRowExecution"("storeId", "accountId");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyImportRowExecution_sourceId_status_idx" ON "WeleticLoyaltyImportRowExecution"("sourceId", "status");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyOutboxJob_status_priority_scheduledFor_nextRetryAt_idx" ON "WeleticLoyaltyOutboxJob"("status", "priority", "scheduledFor", "nextRetryAt");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyOutboxJob_status_scheduledFor_priority_nextRetryAt_idx" ON "WeleticLoyaltyOutboxJob"("status", "scheduledFor", "priority", "nextRetryAt");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyOutboxJob_storeId_jobType_status_idx" ON "WeleticLoyaltyOutboxJob"("storeId", "jobType", "status");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyOutboxJob_lockedAt_idx" ON "WeleticLoyaltyOutboxJob"("lockedAt");

-- CreateIndex
CREATE INDEX "WeleticLoyaltyOutboxJob_createdAt_idx" ON "WeleticLoyaltyOutboxJob"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticLoyaltyOutboxJob_storeId_idempotencyKey_key" ON "WeleticLoyaltyOutboxJob"("storeId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "WeleticShopifyFlowTriggerState_storeId_hasEnabledFlow_idx" ON "WeleticShopifyFlowTriggerState"("storeId", "hasEnabledFlow");

-- CreateIndex
CREATE INDEX "WeleticShopifyFlowTriggerState_observedAt_idx" ON "WeleticShopifyFlowTriggerState"("observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyFlowTriggerState_storeId_triggerDefinitionId_key" ON "WeleticShopifyFlowTriggerState"("storeId", "triggerDefinitionId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopifyInstallIntent_tokenHash_key" ON "WeleticShopifyInstallIntent"("tokenHash");

-- CreateIndex
CREATE INDEX "WeleticShopifyInstallIntent_workspaceId_shopDomain_idx" ON "WeleticShopifyInstallIntent"("workspaceId", "shopDomain");

-- CreateIndex
CREATE INDEX "WeleticShopifyInstallIntent_expiresAt_idx" ON "WeleticShopifyInstallIntent"("expiresAt");

-- CreateIndex
CREATE INDEX "WeleticReviewPrivacyBackfillAudit_storeId_runId_idx" ON "WeleticReviewPrivacyBackfillAudit"("storeId", "runId");

-- CreateIndex
CREATE INDEX "WeleticReviewOwnerPrivacyCoverage_storeId_state_keySetDigest_idx" ON "WeleticReviewOwnerPrivacyCoverage"("storeId", "state", "keySetDigest");

-- CreateIndex
CREATE INDEX "review_owner_privacy_identity_match" ON "WeleticReviewOwnerPrivacyIdentity"("storeId", "identityKind", "identityKeyId", "customerDigest");

-- CreateIndex
CREATE INDEX "WeleticReviewOwnerPrivacyIdentity_identityKeyId_idx" ON "WeleticReviewOwnerPrivacyIdentity"("identityKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticOpenReviewPolicy_storeId_revision_key" ON "WeleticOpenReviewPolicy"("storeId", "revision");

-- CreateIndex
CREATE INDEX "WeleticReviewSettings_storeId_activeIncentivePolicyId_idx" ON "WeleticReviewSettings"("storeId", "activeIncentivePolicyId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticReviewIncentivePolicy_storeId_id_key" ON "WeleticReviewIncentivePolicy"("storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticReviewIncentivePolicy_storeId_revision_key" ON "WeleticReviewIncentivePolicy"("storeId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticReviewIncentiveActivation_merchantActionId_key" ON "WeleticReviewIncentiveActivation"("merchantActionId");

-- CreateIndex
CREATE INDEX "review_incentive_activation_effective" ON "WeleticReviewIncentiveActivation"("storeId", "effectiveAt", "policyRevision");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticReviewIncentiveActivation_storeId_policyId_key" ON "WeleticReviewIncentiveActivation"("storeId", "policyId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticReviewIncentiveActivation_storeId_policyRevision_key" ON "WeleticReviewIncentiveActivation"("storeId", "policyRevision");

-- CreateIndex
CREATE INDEX "review_claim_recovery_scan" ON "WeleticReviewIncentiveClaim"("status", "subjectType", "recoveryDiscoveryCheckedAt", "id");

-- CreateIndex
CREATE INDEX "WeleticReviewIncentiveClaim_storeId_shopperId_idx" ON "WeleticReviewIncentiveClaim"("storeId", "shopperId");

-- CreateIndex
CREATE INDEX "WeleticReviewIncentiveClaim_storeId_policyId_idx" ON "WeleticReviewIncentiveClaim"("storeId", "policyId");

-- CreateIndex
CREATE INDEX "WeleticReviewIncentiveClaim_orderId_idx" ON "WeleticReviewIncentiveClaim"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "wl_review_claim_store_id_uq" ON "WeleticReviewIncentiveClaim"("storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "wl_review_incentive_order_uq" ON "WeleticReviewIncentiveClaim"("storeId", "orderId");

-- CreateIndex
CREATE INDEX "wl_review_invalidation_shopper_idx" ON "WeleticReviewIncentiveInvalidation"("storeId", "shopperId", "id");

-- CreateIndex
CREATE INDEX "wl_review_invalidation_work_idx" ON "WeleticReviewIncentiveInvalidation"("storeId", "outcome", "id");

-- CreateIndex
CREATE UNIQUE INDEX "wl_review_invalidation_decision_uq" ON "WeleticReviewIncentiveInvalidation"("storeId", "decisionId");

-- CreateIndex
CREATE UNIQUE INDEX "wl_review_invalidation_claim_uq" ON "WeleticReviewIncentiveInvalidation"("storeId", "claimId");

-- CreateIndex
CREATE UNIQUE INDEX "wl_review_invalidation_cleanup_uq" ON "WeleticReviewIncentiveInvalidation"("storeId", "cleanupId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticReviewRequest_tokenHash_key" ON "WeleticReviewRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "WeleticReviewRequest_storeId_status_sendAt_id_idx" ON "WeleticReviewRequest"("storeId", "status", "sendAt", "id");

-- CreateIndex
CREATE INDEX "WeleticReviewRequest_storeId_shopperId_idx" ON "WeleticReviewRequest"("storeId", "shopperId");

-- CreateIndex
CREATE INDEX "WeleticReviewRequest_status_deliveryLeaseExpiresAt_idx" ON "WeleticReviewRequest"("status", "deliveryLeaseExpiresAt");

-- CreateIndex
CREATE INDEX "review_request_retention_expiry" ON "WeleticReviewRequest"("expiresAt", "id");

-- CreateIndex
CREATE INDEX "WeleticReviewRequest_orderId_idx" ON "WeleticReviewRequest"("orderId");

-- CreateIndex
CREATE INDEX "WeleticReviewRequest_productId_idx" ON "WeleticReviewRequest"("productId");

-- CreateIndex
CREATE INDEX "WeleticReviewRequest_storeId_incentivePolicyId_idx" ON "WeleticReviewRequest"("storeId", "incentivePolicyId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticReviewRequest_storeId_orderId_productId_key" ON "WeleticReviewRequest"("storeId", "orderId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticReviewRequest_storeId_id_key" ON "WeleticReviewRequest"("storeId", "id");

-- CreateIndex
CREATE INDEX "review_reminder_due" ON "WeleticReviewReminder"("status", "scheduledFor", "id");

-- CreateIndex
CREATE INDEX "review_reminder_discovery" ON "WeleticReviewReminder"("status", "updatedAt", "id");

-- CreateIndex
CREATE INDEX "review_reminder_request_status" ON "WeleticReviewReminder"("storeId", "requestId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "review_reminder_delivery_uq" ON "WeleticReviewReminder"("storeId", "requestId", "sequence");

-- CreateIndex
CREATE INDEX "WeleticReviewRequestLine_orderLineId_idx" ON "WeleticReviewRequestLine"("orderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticReviewRequestLine_requestId_orderLineId_key" ON "WeleticReviewRequestLine"("requestId", "orderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticProductReview_requestId_key" ON "WeleticProductReview"("requestId");

-- CreateIndex
CREATE INDEX "WeleticProductReview_storeId_productId_status_createdAt_id_idx" ON "WeleticProductReview"("storeId", "productId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "WeleticProductReview_storeId_status_createdAt_id_idx" ON "WeleticProductReview"("storeId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "WeleticProductReview_storeId_shopperId_idx" ON "WeleticProductReview"("storeId", "shopperId");

-- CreateIndex
CREATE INDEX "WeleticProductReview_productId_idx" ON "WeleticProductReview"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticProductReview_storeId_id_key" ON "WeleticProductReview"("storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticProductReview_storeId_requestId_key" ON "WeleticProductReview"("storeId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "open_review_source_review" ON "WeleticOpenReviewSubmission"("reviewId");

-- CreateIndex
CREATE INDEX "open_review_author_rate" ON "WeleticOpenReviewSubmission"("storeId", "shopperId", "createdAt");

-- CreateIndex
CREATE INDEX "open_review_source_privacy" ON "WeleticOpenReviewSubmission"("storeId", "redactedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "open_review_operation" ON "WeleticOpenReviewSubmission"("storeId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "open_review_owned_source" ON "WeleticOpenReviewSubmission"("storeId", "reviewId");

-- CreateIndex
CREATE INDEX "review_translation_privacy" ON "WeleticProductReviewTranslation"("storeId", "redactedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "review_translation_locale" ON "WeleticProductReviewTranslation"("storeId", "reviewId", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticProductReviewTranslation_storeId_id_key" ON "WeleticProductReviewTranslation"("storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "review_translation_action" ON "WeleticReviewTranslationAudit"("merchantActionId");

-- CreateIndex
CREATE INDEX "review_translation_actor_privacy" ON "WeleticReviewTranslationAudit"("storeId", "staffRedactedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "review_translation_audit_revision" ON "WeleticReviewTranslationAudit"("storeId", "translationId", "toRevision");

-- CreateIndex
CREATE INDEX "review_moderation_store_created" ON "WeleticReviewModerationAudit"("storeId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "review_moderation_redaction" ON "WeleticReviewModerationAudit"("storeId", "redactedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "review_moderation_version_unique" ON "WeleticReviewModerationAudit"("storeId", "reviewId", "toVersion");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticReviewMedia_objectKey_key" ON "WeleticReviewMedia"("objectKey");

-- CreateIndex
CREATE INDEX "WeleticReviewMedia_storeId_requestId_status_idx" ON "WeleticReviewMedia"("storeId", "requestId", "status");

-- CreateIndex
CREATE INDEX "WeleticReviewMedia_storeId_reviewId_idx" ON "WeleticReviewMedia"("storeId", "reviewId");

-- CreateIndex
CREATE INDEX "WeleticReviewMedia_status_uploadExpiresAt_idx" ON "WeleticReviewMedia"("status", "uploadExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "review_media_owned_id" ON "WeleticReviewMedia"("storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "open_review_media_id" ON "WeleticOpenReviewMediaOwnership"("mediaId");

-- CreateIndex
CREATE INDEX "open_review_media_author_rate" ON "WeleticOpenReviewMediaOwnership"("storeId", "shopperId", "createdAt");

-- CreateIndex
CREATE INDEX "open_review_media_submission" ON "WeleticOpenReviewMediaOwnership"("storeId", "submissionKey");

-- CreateIndex
CREATE INDEX "open_review_media_privacy" ON "WeleticOpenReviewMediaOwnership"("storeId", "redactedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "open_review_media_owner" ON "WeleticOpenReviewMediaOwnership"("storeId", "mediaId");

-- CreateIndex
CREATE UNIQUE INDEX "open_review_media_operation" ON "WeleticOpenReviewMediaOwnership"("storeId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "WeleticShopifyStaffGrant_storeId_updatedAt_idx" ON "WeleticShopifyStaffGrant"("storeId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_staff_grant_scope" ON "WeleticShopifyStaffGrant"("storeId", "appId", "installationGeneration", "shopifyUserId");

-- CreateIndex
CREATE INDEX "WeleticShopifyMerchantAction_storeId_createdAt_id_idx" ON "WeleticShopifyMerchantAction"("storeId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "shopify_subscription_refresh_index" ON "WeleticShopifySubscriptionSnapshot"("status", "validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_subscription_installation_key" ON "WeleticShopifySubscriptionSnapshot"("appId", "pendingInstallationId", "installationGeneration");

-- CreateIndex
CREATE INDEX "wl_delivery_capacity_idx" ON "WeleticShopperDeliveryReservation"("storeId", "capacityAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticShopperDeliveryReservation_storeId_id_key" ON "WeleticShopperDeliveryReservation"("storeId", "id");

-- CreateIndex
CREATE INDEX "wl_delivery_identity_lookup_idx" ON "WeleticShopperDeliveryIdentity"("storeId", "identityKind", "identityKeyId", "customerDigest");

-- CreateIndex
CREATE UNIQUE INDEX "wl_delivery_identity_unique" ON "WeleticShopperDeliveryIdentity"("storeId", "reservationId", "identityKind", "identityKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticStoreReviewSettings_storeId_key" ON "WeleticStoreReviewSettings"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticStoreReviewRequest_tokenHash_key" ON "WeleticStoreReviewRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "WeleticStoreReviewRequest_orderId_idx" ON "WeleticStoreReviewRequest"("orderId");

-- CreateIndex
CREATE INDEX "WeleticStoreReviewRequest_storeId_shopperId_idx" ON "WeleticStoreReviewRequest"("storeId", "shopperId");

-- CreateIndex
CREATE INDEX "WeleticStoreReviewRequest_storeId_incentivePolicyId_idx" ON "WeleticStoreReviewRequest"("storeId", "incentivePolicyId");

-- CreateIndex
CREATE INDEX "store_review_request_due" ON "WeleticStoreReviewRequest"("storeId", "status", "sendAt", "id");

-- CreateIndex
CREATE INDEX "store_review_request_lease" ON "WeleticStoreReviewRequest"("status", "deliveryLeaseExpiresAt");

-- CreateIndex
CREATE INDEX "store_review_request_expiry" ON "WeleticStoreReviewRequest"("expiresAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticStoreReviewRequest_storeId_id_key" ON "WeleticStoreReviewRequest"("storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticStoreReviewRequest_storeId_orderId_key" ON "WeleticStoreReviewRequest"("storeId", "orderId");

-- CreateIndex
CREATE INDEX "WeleticStoreReviewRequestLine_storeId_requestId_idx" ON "WeleticStoreReviewRequestLine"("storeId", "requestId");

-- CreateIndex
CREATE INDEX "WeleticStoreReviewRequestLine_orderLineId_idx" ON "WeleticStoreReviewRequestLine"("orderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticStoreReviewRequestLine_requestId_orderLineId_key" ON "WeleticStoreReviewRequestLine"("requestId", "orderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticStoreReview_requestId_key" ON "WeleticStoreReview"("requestId");

-- CreateIndex
CREATE INDEX "WeleticStoreReview_storeId_shopperId_idx" ON "WeleticStoreReview"("storeId", "shopperId");

-- CreateIndex
CREATE INDEX "store_review_listing" ON "WeleticStoreReview"("storeId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "store_review_privacy" ON "WeleticStoreReview"("storeId", "redactedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticStoreReview_storeId_id_key" ON "WeleticStoreReview"("storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WeleticStoreReview_storeId_requestId_key" ON "WeleticStoreReview"("storeId", "requestId");

-- CreateIndex
CREATE INDEX "store_review_moderation_created" ON "WeleticStoreReviewModerationAudit"("storeId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "store_review_moderation_privacy" ON "WeleticStoreReviewModerationAudit"("storeId", "redactedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "store_review_moderation_version" ON "WeleticStoreReviewModerationAudit"("storeId", "reviewId", "toVersion");

-- CreateIndex
CREATE INDEX "Workflow_programId_trigger_idx" ON "Workflow"("programId", "trigger");

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Project_inviteCode_key" ON "Project"("inviteCode");

-- CreateIndex
CREATE UNIQUE INDEX "Project_defaultProgramId_key" ON "Project"("defaultProgramId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_stripeId_key" ON "Project"("stripeId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_invoicePrefix_key" ON "Project"("invoicePrefix");

-- CreateIndex
CREATE UNIQUE INDEX "Project_stripeConnectId_key" ON "Project"("stripeConnectId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_shopifyStoreId_key" ON "Project"("shopifyStoreId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_referralLinkId_key" ON "Project"("referralLinkId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_publishableKey_key" ON "Project"("publishableKey");

-- CreateIndex
CREATE UNIQUE INDEX "Project_ssoEmailDomain_key" ON "Project"("ssoEmailDomain");

-- CreateIndex
CREATE INDEX "Project_usageLastChecked_idx" ON "Project"("usageLastChecked" ASC);

-- CreateIndex
CREATE INDEX "Project_trialEndsAt_idx" ON "Project"("trialEndsAt");

-- CreateIndex
CREATE INDEX "ProjectInvite_projectId_idx" ON "ProjectInvite"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectInvite_email_projectId_key" ON "ProjectInvite"("email", "projectId");

-- CreateIndex
CREATE INDEX "ProjectUsers_projectId_idx" ON "ProjectUsers"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectUsers_userId_projectId_key" ON "ProjectUsers"("userId", "projectId");

-- CreateIndex
CREATE INDEX "SentEmail_projectId_idx" ON "SentEmail"("projectId");



-- CreateTable for Edge ServiceAuthNonce
CREATE TABLE IF NOT EXISTS "ServiceAuthNonce" (
    "nonceKey" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" INTEGER NOT NULL
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ServiceAuthNonce_expiresAt_idx" ON "ServiceAuthNonce"("expiresAt");
