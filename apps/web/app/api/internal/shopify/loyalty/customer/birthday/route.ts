import { prisma } from "@/lib/prisma";
import {
  BirthdayRewardSchedule,
  getBirthdayRewardDateForYear,
  getNextBirthdayRewardSchedule,
} from "@/lib/weletic/loyalty/non-purchase-earn";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import {
  loyaltyErrorResponse,
  loyaltySuccessResponse,
} from "@/lib/weletic/loyalty/response";
import {
  readWeleticShopifyRequestBody,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";
import { Prisma } from "@prisma/client";
import { z } from "zod";

export const dynamic = "force-dynamic";

const birthdayPayloadSchema = z
  .object({
    shop: z.string().min(1),
    shopifyCustomerId: z.string().min(1),
    birthMonth: z.number().int().min(1).max(12),
    birthDay: z.number().int().min(1).max(31),
  })
  .strict();

const BIRTHDAY_REGISTRATION_MAX_ATTEMPTS = 5;

interface StoredBirthday {
  birthDate: string;
  registeredAt?: string;
  nextEligibleYear?: number;
}

function readMetadata(metadata: Prisma.JsonValue | null) {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, any>)
    : {};
}

function readStoredBirthday(
  metadata: Record<string, any>,
): StoredBirthday | null {
  const birthday = metadata.birthday;
  if (
    !birthday ||
    typeof birthday !== "object" ||
    Array.isArray(birthday) ||
    typeof birthday.birthDate !== "string"
  ) {
    return null;
  }

  return {
    birthDate: birthday.birthDate,
    registeredAt:
      typeof birthday.registeredAt === "string"
        ? birthday.registeredAt
        : undefined,
    nextEligibleYear:
      typeof birthday.nextEligibleYear === "number" &&
      Number.isInteger(birthday.nextEligibleYear)
        ? birthday.nextEligibleYear
        : undefined,
  };
}

function getStoredBirthdaySchedule({
  birthday,
  now,
}: {
  birthday: Required<Pick<StoredBirthday, "birthDate" | "registeredAt">> &
    StoredBirthday;
  now?: Date;
}): BirthdayRewardSchedule {
  if (birthday.nextEligibleYear !== undefined) {
    return {
      calendarYear: birthday.nextEligibleYear,
      scheduledFor: getBirthdayRewardDateForYear(
        birthday.birthDate,
        birthday.nextEligibleYear,
      ),
    };
  }

  return getNextBirthdayRewardSchedule({
    birthDate: birthday.birthDate,
    registeredAt: birthday.registeredAt,
    now,
  });
}

export async function POST(request: Request) {
  const bodyText = await readWeleticShopifyRequestBody(request);
  if (
    bodyText === null ||
    !verifyWeleticShopifyRequest({ request, body: bodyText })
  ) {
    return loyaltyErrorResponse(
      "unauthorized",
      "Unauthorized service request",
      401,
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    return loyaltyErrorResponse(
      "bad_request",
      "Invalid JSON request body",
      400,
    );
  }

  const validation = birthdayPayloadSchema.safeParse(parsedBody);
  if (!validation.success) {
    return loyaltyErrorResponse(
      "validation_failed",
      "Invalid birthday payload",
      422,
      validation.error.format(),
    );
  }

  const { shop, shopifyCustomerId, birthMonth, birthDay } = validation.data;
  const birthdayDate = new Date(Date.UTC(2000, birthMonth - 1, birthDay));
  if (
    birthdayDate.getUTCMonth() !== birthMonth - 1 ||
    birthdayDate.getUTCDate() !== birthDay
  ) {
    return loyaltyErrorResponse(
      "validation_failed",
      "Birthday month and day are not a valid calendar date",
      422,
    );
  }
  const birthDate = `2000-${String(birthMonth).padStart(2, "0")}-${String(
    birthDay,
  ).padStart(2, "0")}`;

  const resolution = await resolveShopifyStoreByDomain(shop);
  if (!resolution?.storeId) {
    return loyaltyErrorResponse(
      "store_not_found",
      `Store ${shop} not found`,
      404,
    );
  }
  const operationalStore = await assertShopifyStoreAcceptsOperationalWrites({
    storeId: resolution.storeId,
    action: "loyalty_birthday_registration",
  });
  const expectedInstallationGeneration =
    operationalStore?.installationGeneration ?? null;

  const account = await prisma.weleticLoyaltyAccount.findFirst({
    where: {
      storeId: resolution.storeId,
      status: "active",
      shopper: { shopifyCustomerId },
    },
    include: {
      program: {
        include: {
          earningRules: {
            where: {
              triggerCode: "birthday",
              ruleType: "fixed_points",
              isActive: true,
              deletedAt: null,
            },
            take: 1,
          },
        },
      },
    },
  });

  if (!account) {
    return loyaltyErrorResponse(
      "account_not_found",
      "Loyalty account not found",
      404,
    );
  }
  if (
    account.program.status !== "active" ||
    account.program.killSwitchActive ||
    account.program.earningRules.length === 0
  ) {
    return loyaltyErrorResponse(
      "birthday_not_enabled",
      "Birthday rewards are not currently enabled",
      409,
    );
  }

  const requestedRegisteredAt = new Date().toISOString();
  let candidate = {
    metadata: account.metadata,
    updatedAt: account.updatedAt,
  };

  for (
    let attempt = 0;
    attempt < BIRTHDAY_REGISTRATION_MAX_ATTEMPTS;
    attempt++
  ) {
    const existingMetadata = readMetadata(candidate.metadata);
    const existingBirthday = readStoredBirthday(existingMetadata);

    if (existingBirthday?.birthDate !== undefined) {
      if (existingBirthday.birthDate !== birthDate) {
        return loyaltyErrorResponse(
          "birthday_locked",
          "Birthday is already registered. Contact support to correct it.",
          409,
        );
      }

      if (
        existingBirthday.registeredAt &&
        !Number.isNaN(Date.parse(existingBirthday.registeredAt))
      ) {
        const schedule = getStoredBirthdaySchedule({
          birthday: {
            ...existingBirthday,
            registeredAt: existingBirthday.registeredAt,
          },
        });
        return loyaltySuccessResponse({
          birthMonth,
          birthDay,
          registeredAt: existingBirthday.registeredAt,
          nextRewardAt: schedule.scheduledFor,
          nextEligibleYear: schedule.calendarYear,
        });
      }
    }

    const schedule = getNextBirthdayRewardSchedule({
      birthDate,
      registeredAt: requestedRegisteredAt,
    });
    const claimed = await prisma.$transaction(async (tx) => {
      await assertShopifyStoreAcceptsOperationalWrites({
        storeId: resolution.storeId!,
        action: "loyalty_birthday_registration",
        expectedInstallationGeneration,
        tx,
      });
      const update = await tx.weleticLoyaltyAccount.updateMany({
        where: {
          id: account.id,
          storeId: resolution.storeId!,
          status: "active",
          updatedAt: candidate.updatedAt,
        },
        data: {
          metadata: {
            ...existingMetadata,
            birthday: {
              birthDate,
              registeredAt: requestedRegisteredAt,
              nextEligibleYear: schedule.calendarYear,
            },
          } as Prisma.InputJsonValue,
        },
      });
      if (update.count !== 1) {
        return false;
      }

      await enqueueOutboxJob({
        storeId: resolution.storeId!,
        jobType: "BIRTHDAY_REWARD",
        payload: {
          accountId: account.id,
          birthDate,
          registeredAt: requestedRegisteredAt,
          calendarYear: schedule.calendarYear,
        },
        scheduledFor: schedule.scheduledFor,
        idempotencyKey: `birthday_reward:${account.id}:${schedule.calendarYear}`,
        tx,
      });
      return true;
    });

    if (claimed) {
      return loyaltySuccessResponse({
        birthMonth,
        birthDay,
        registeredAt: requestedRegisteredAt,
        nextRewardAt: schedule.scheduledFor,
        nextEligibleYear: schedule.calendarYear,
      });
    }

    const reloaded = await prisma.weleticLoyaltyAccount.findFirst({
      where: {
        id: account.id,
        storeId: resolution.storeId,
        status: "active",
        shopper: { shopifyCustomerId },
      },
      select: {
        metadata: true,
        updatedAt: true,
      },
    });
    if (!reloaded) {
      return loyaltyErrorResponse(
        "account_not_found",
        "Loyalty account not found",
        404,
      );
    }
    candidate = reloaded;
  }

  return loyaltyErrorResponse(
    "registration_conflict",
    "Birthday registration conflicted with another account update. Please retry.",
    409,
  );
}
