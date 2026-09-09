import { Prisma } from "@prisma/client";

/** The caller holds a frozen store's writer fence and compliance lease.
 * Drain children before source provenance, without touching accounting tables.
 */
export async function purgeHistoricalImportStoreBatch({
  tx,
  storeId,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
}) {
  const page = {
    where: { storeId },
    take: 100,
    orderBy: { id: "asc" as const },
    select: { id: true },
  };
  const executions = await tx.weleticLoyaltyImportRowExecution.findMany(page);
  if (executions.length) {
    const result = await tx.weleticLoyaltyImportRowExecution.deleteMany({
      where: { storeId, id: { in: executions.map((row) => row.id) } },
    });
    if (result.count !== executions.length)
      throw new Error("Import privacy cleanup conflict");
    return { kind: "executions" as const, count: result.count };
  }
  const snapshots = await tx.weleticLoyaltyImportRowSnapshot.findMany(page);
  if (snapshots.length) {
    const result = await tx.weleticLoyaltyImportRowSnapshot.deleteMany({
      where: { storeId, id: { in: snapshots.map((row) => row.id) } },
    });
    if (result.count !== snapshots.length)
      throw new Error("Import privacy cleanup conflict");
    return { kind: "snapshots" as const, count: result.count };
  }
  const sources = await tx.weleticLoyaltyImportSource.findMany(page);
  if (sources.length) {
    const result = await tx.weleticLoyaltyImportSource.deleteMany({
      where: { storeId, id: { in: sources.map((row) => row.id) } },
    });
    if (result.count !== sources.length)
      throw new Error("Import privacy cleanup conflict");
    return { kind: "sources" as const, count: result.count };
  }
  return { kind: "completed" as const, count: 0 };
}

/** Caller holds the compliance mutation lease and store writer fence. */
export async function redactHistoricalImportCustomerBatch({
  tx,
  storeId,
  shopifyCustomerId,
  accountId,
  now = new Date(),
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  shopifyCustomerId?: string;
  accountId?: string;
  now?: Date;
}) {
  const numericId = shopifyCustomerId?.replace(
    /^gid:\/\/shopify\/Customer\//,
    "",
  );
  const identities =
    numericId && /^[1-9][0-9]{0,19}$/.test(numericId)
      ? [numericId, `gid://shopify/Customer/${numericId}`]
      : [];
  const identitySnapshots = identities.length
    ? await tx.weleticLoyaltyImportRowSnapshot.findMany({
        where: {
          storeId,
          shopifyCustomerId: { in: identities },
          redactedAt: null,
        },
        take: 100,
        orderBy: { id: "asc" },
        select: { id: true, sourceId: true },
      })
    : [];
  const snapshotIds = identitySnapshots.map((row) => row.id);
  const owners = [
    ...(accountId ? [{ accountId }] : []),
    ...(snapshotIds.length ? [{ snapshotId: { in: snapshotIds } }] : []),
  ];
  const executions = owners.length
    ? await tx.weleticLoyaltyImportRowExecution.findMany({
        where: {
          storeId,
          AND: [
            { OR: owners },
            {
              OR: [
                { containmentCode: null },
                { containmentCode: { not: "privacy_redacted" } },
              ],
            },
          ],
        },
        take: 100,
        orderBy: { id: "asc" },
        select: { id: true, sourceId: true, snapshotId: true },
      })
    : [];
  // Follow durable account ownership when the raw customer identity is gone.
  const linkedIds = executions
    .map((row) => row.snapshotId)
    .filter((id) => !snapshotIds.includes(id));
  const linkedSnapshots = linkedIds.length
    ? await tx.weleticLoyaltyImportRowSnapshot.findMany({
        where: { storeId, id: { in: linkedIds }, redactedAt: null },
        take: 100,
        orderBy: { id: "asc" },
        select: { id: true, sourceId: true },
      })
    : [];
  const snapshots = [...identitySnapshots, ...linkedSnapshots];
  const sourceIds = [
    ...new Set([...snapshots, ...executions].map((row) => row.sourceId)),
  ].sort();
  for (const id of sourceIds) {
    await tx.weleticLoyaltyImportSource.updateMany({
      where: { id, storeId },
      data: {
        status: "contained",
        revision: { increment: 1 },
        leaseId: null,
        leaseExpiresAt: null,
      },
    });
  }
  for (const row of snapshots) {
    await tx.weleticLoyaltyImportRowSnapshot.updateMany({
      where: { id: row.id, storeId, redactedAt: null },
      data: {
        shopifyCustomerId: `redacted:${row.id}`,
        birthdayMonth: null,
        birthdayDay: null,
        tierId: null,
        redactedAt: now,
      },
    });
  }
  if (executions.length) {
    await tx.weleticLoyaltyImportRowExecution.updateMany({
      where: { storeId, id: { in: executions.map((row) => row.id) } },
      data: {
        fieldStateBefore: Prisma.DbNull,
        fieldStateAfter: Prisma.DbNull,
        status: "contained",
        containmentCode: "privacy_redacted",
      },
    });
  }
  return {
    snapshotsRedacted: snapshots.length,
    executionsRedacted: executions.length,
  };
}
