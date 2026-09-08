import type { Prisma } from "@prisma/client";
import { loyaltyConfigurationUpdateSchema } from "./configuration-contract";
import {
  configurationSelect,
  normalizeConfiguration,
  projectConfiguration,
} from "./configuration-state";
import {
  LoyaltySettingsWriteError,
  writeValidatedLoyaltySettingsInTransaction,
} from "./settings-writer";

export async function readLoyaltyConfigurationInTransaction(
  tx: Prisma.TransactionClient,
  storeId: string,
) {
  return projectConfiguration(
    await tx.weleticLoyaltyProgram.findUnique({
      where: { storeId },
      select: configurationSelect,
    }),
  );
}

/** Authorized, fenced internal primitive. The gateway must check tenant,
 * installation and owner authority on the same transaction before calling.
 * Never retry a mutation here or initialize a program during a read.
 */
export async function writeLoyaltyConfigurationInTransaction({
  tx,
  storeId,
  accountingCurrency,
  input,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  accountingCurrency: string;
  input: unknown;
}) {
  const data = loyaltyConfigurationUpdateSchema.parse(input);
  const current = await readLoyaltyConfigurationInTransaction(tx, storeId);
  if (data.expectedRevision !== current.configurationRevision)
    throw new LoyaltySettingsWriteError({
      code: "conflict",
      message: "Configuration changed. Reload before saving",
    });
  const currency = data.settings.liabilityValuationCurrency;
  if (currency != null && currency !== accountingCurrency)
    throw new LoyaltySettingsWriteError({
      code: "bad_request",
      message: "Valuation must match the accounting currency",
    });
  await writeValidatedLoyaltySettingsInTransaction(tx, storeId, {
    ...normalizeConfiguration(data.settings),
    expectedStatus: current.program?.settings.status ?? "not_configured",
  });
  const saved = await readLoyaltyConfigurationInTransaction(tx, storeId);
  if (!saved.program)
    throw new Error("Saved Loyalty configuration is unavailable");
  return saved;
}
