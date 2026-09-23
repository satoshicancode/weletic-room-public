import { prisma } from "@/lib/prisma";

/** Bounded physical deletion, including inactive/uninstalled stores. This does
 * not authorize another send: terminal metadata prevents a fresh retry key or
 * regenerated payload after ambiguous delivery. No PII leaves this function.
 */
export async function purgeAnonymousReferralConfirmations({
  take,
  now,
}: {
  take: number;
  now: Date;
}) {
  if (
    !Number.isInteger(take) ||
    take < 1 ||
    take > 100 ||
    !Number.isFinite(now.getTime())
  )
    throw new Error("Invalid confirmation retention batch");
  const cutoff = new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString();
  return prisma.$executeRaw`
    UPDATE WeleticLoyaltyReferral
    SET metadata = JSON_SET(JSON_REMOVE(metadata, '$.anonymousConfirmationDelivery'), '$.anonymousConfirmationTerminal', 'expired_or_reconciliation'),
        friendEmailLeaseToken = NULL,
        friendEmailLeaseReservedAt = NULL,
        friendEmailLeaseExpiresAt = ${now},
        friendEmailLastError = NULL,
        updatedAt = UTC_TIMESTAMP(3)
    WHERE JSON_CONTAINS_PATH(metadata, 'one', '$.anonymousConfirmationDelivery') = 1
      AND (
        friendRewardEmailedAt IS NOT NULL
        OR COALESCE(JSON_TYPE(JSON_EXTRACT(metadata, '$.friendPrivacySnapshot')) <> 'OBJECT', TRUE)
        OR JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.friendPrivacySnapshot.retainUntil')) <= ${now.toISOString()}
        OR COALESCE(JSON_TYPE(JSON_EXTRACT(metadata, '$.anonymousConfirmationDelivery')) <> 'OBJECT', TRUE)
        OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.anonymousConfirmationDelivery.preparedAt')), '') NOT REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.anonymousConfirmationDelivery.expiresAt')), '') NOT REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        OR ((friendEmailDeliveryAttempts > 0 OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.anonymousConfirmationQueued')), 'false') <> 'true') AND (
          JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.anonymousConfirmationDelivery.preparedAt')) <= ${cutoff}
          OR JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.anonymousConfirmationDelivery.expiresAt')) <= ${now.toISOString()}
        ))
        OR friendRewardExpiresAt <= ${now}
        OR JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.anonymousConfirmationDelivery.preparedAt')) > ${now.toISOString()}
        OR JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.anonymousConfirmationDelivery.expiresAt')) <= JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.anonymousConfirmationDelivery.preparedAt'))
      )
    ORDER BY id ASC
    LIMIT ${take}
  `;
}
