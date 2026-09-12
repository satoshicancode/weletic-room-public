import { decrypt, encrypt } from "@/lib/encryption";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { ShopifyCredentialUnavailableError } from "./credential-errors";
import { readPendingInstallation } from "./installation-admission";
import { observeShopifySessionCoordination } from "./session-coordination";
import { lockShopifySessionLifecycle } from "./session-lifecycle-fence";

const identitySchema = z
  .object({
    storeId: z.string().min(1).max(191),
    workspaceId: z.string().min(1).max(191),
    appId: z.string().regex(/^[a-z0-9_-]{1,191}$/),
    shop: z
      .string()
      .max(191)
      .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    installationGeneration: z.string().min(1).max(64),
  })
  .strict();
const materialSchema = z
  .object({
    accessToken: z.string().min(1).max(8192),
    scope: z.string().max(8192),
  })
  .strict();
const envelopeSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().positive().max(2147483646),
    identity: identitySchema,
    material: materialSchema,
  })
  .strict();
type Identity = z.infer<typeof identitySchema>;
type CredentialRow = {
  id: string;
  storeId: string;
  appId: string;
  installationGeneration: string;
  revision: number;
  credentialCiphertext: string;
};

/** Caller holds Store then coordinator locks. Missing admission must not
 * downgrade a previously native installation to generic credential authority. */
export async function assertLegacyShopifyCredentialAuthority(
  tx: Prisma.TransactionClient,
  storeId: string,
  appId: string,
) {
  if (!appId || appId !== process.env.SHOPIFY_API_KEY?.trim())
    throw new ShopifyCredentialUnavailableError(
      "Credential app identity does not match",
    );
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticShopifyInstallationCredential
    WHERE storeId = ${storeId} AND appId = ${appId} LIMIT 1 FOR UPDATE
  `);
  if (rows.length)
    throw new ShopifyCredentialUnavailableError(
      "Native Shopify credential requires its admission record",
    );
}

/** Internal persistence primitive, NOT merchant/worker authorization. Caller
 * owns an interactive transaction and authenticates the operation separately.
 * No legacy fallback; the runtime cutover must wire every reader/writer together.
 */
async function lockIdentity(tx: Prisma.TransactionClient, input: unknown) {
  const identity = identitySchema.parse(input);
  if (identity.appId !== process.env.SHOPIFY_API_KEY?.trim())
    throw new ShopifyCredentialUnavailableError(
      "Credential app identity does not match",
    );
  const store = await lockShopifySessionLifecycle({
    tx,
    shop: identity.shop,
    storeId: identity.storeId,
  });
  if (
    !store ||
    store.id !== identity.storeId ||
    store.projectId !== identity.workspaceId ||
    store.shopDomain !== identity.shop ||
    store.installationGeneration !== identity.installationGeneration
  )
    throw new ShopifyCredentialUnavailableError(
      "Credential store identity or generation changed",
    );
  const pending = await readPendingInstallation(tx, identity);
  if (
    !pending ||
    pending.state !== "mapped" ||
    pending.mappedStoreId !== store.id ||
    pending.installationGeneration !== identity.installationGeneration ||
    !pending.authenticatedAt ||
    pending.uninstalledAt ||
    pending.redactedAt
  )
    throw new ShopifyCredentialUnavailableError(
      "Credential requires the current mapped admission",
    );
  const row = await lockCredentialRow(tx, identity);
  return { identity, row };
}

async function lockCredentialRow(
  tx: Prisma.TransactionClient,
  identity: Identity,
) {
  const rows = await tx.$queryRaw<CredentialRow[]>(Prisma.sql`
    SELECT id, storeId, appId, installationGeneration, revision, credentialCiphertext
    FROM WeleticShopifyInstallationCredential
    WHERE storeId = ${identity.storeId} AND appId = ${identity.appId} LIMIT 2 FOR UPDATE
  `);
  if (rows.length > 1)
    throw new ShopifyCredentialUnavailableError("Ambiguous store credential");
  const row = rows[0];
  if (
    row &&
    (row.storeId !== identity.storeId ||
      row.appId !== identity.appId ||
      row.installationGeneration !== identity.installationGeneration ||
      !Number.isInteger(row.revision) ||
      row.revision < 1 ||
      row.revision > 2147483646)
  )
    throw new ShopifyCredentialUnavailableError(
      "Credential record identity or revision changed",
    );
  return row;
}
function openEnvelope(row: CredentialRow, identity: Identity) {
  try {
    const envelope = envelopeSchema.parse(
      JSON.parse(decrypt(row.credentialCiphertext)),
    );
    if (envelope.revision !== row.revision)
      throw new Error("Revision mismatch");
    for (const key of Object.keys(identity) as Array<keyof Identity>)
      if (envelope.identity[key] !== identity[key])
        throw new Error("Identity mismatch");
    return envelope.material;
  } catch {
    // Decryption/parser errors may embed credential content. Never propagate it.
    throw new ShopifyCredentialUnavailableError(
      "Stored Shopify credential cannot be verified",
    );
  }
}
export async function readStoreOwnedShopifyCredential(
  tx: Prisma.TransactionClient,
  input: unknown,
) {
  const { identity, row } = await lockIdentity(tx, input);
  return row
    ? { revision: row.revision, ...openEnvelope(row, identity) }
    : null;
}

/** Cleanup-only credential capability. Caller must keep this transaction open
 * through the bounded voucher lookup/deactivation; never use it for earning,
 * issuance, session publication, or token refresh. No legacy/SDK fallback. */
export async function readFrozenStoreOwnedVoucherCredential(
  tx: Prisma.TransactionClient,
  input: unknown,
) {
  const proof = z
    .object({
      storeId: z.string().min(1).max(191),
      cleanupId: z.string().min(1).max(191),
      redemptionId: z.string().min(1).max(191),
      lockOwner: z.string().min(1).max(191),
      leaseVersion: z.number().int().positive(),
      source: z.enum(["app_uninstalled", "shop_redact"]),
      expectedCode: z.string().min(1).max(255),
    })
    .strict()
    .parse(input);
  const [store] = await tx.$queryRaw<
    Array<{
      id: string;
      projectId: string;
      shopDomain: string;
      complianceState: string;
      installationGeneration: string | null;
    }>
  >(Prisma.sql`
    SELECT id, projectId, shopDomain, complianceState, installationGeneration
    FROM WeleticShopifyStore WHERE id = ${proof.storeId} LIMIT 1 FOR UPDATE
  `);
  if (
    !store ||
    store.id !== proof.storeId ||
    store.complianceState !== "frozen" ||
    !store.installationGeneration
  )
    throw new ShopifyCredentialUnavailableError(
      "Frozen voucher credential lifecycle changed",
    );
  const identity = identitySchema.parse({
    storeId: store.id,
    workspaceId: store.projectId,
    shop: store.shopDomain,
    appId: process.env.SHOPIFY_API_KEY?.trim() || "",
    installationGeneration: store.installationGeneration,
  });
  await observeShopifySessionCoordination(tx, identity);
  const admission = await readPendingInstallation(tx, identity);
  if (
    !admission ||
    admission.mappedStoreId !== store.id ||
    admission.installationGeneration !== store.installationGeneration ||
    !admission.authenticatedAt ||
    admission.redactedAt ||
    !(
      (admission.state === "uninstalled" && admission.uninstalledAt) ||
      (proof.source === "shop_redact" &&
        admission.state === "mapped" &&
        !admission.uninstalledAt)
    )
  )
    throw new ShopifyCredentialUnavailableError(
      "Frozen voucher admission changed",
    );
  const credential = await lockCredentialRow(tx, identity);
  if (!credential)
    throw new ShopifyCredentialUnavailableError(
      "Frozen voucher credential is unavailable",
    );
  const [lease] = await tx.$queryRaw<
    Array<{
      id: string;
      storeId: string;
      redemptionId: string;
      source: string;
      status: string;
      lockedBy: string | null;
      leaseVersion: number;
      expectedDiscountCodeCanonical: string;
      live: number | bigint;
    }>
  >(Prisma.sql`
    SELECT id, storeId, redemptionId, source, status, lockedBy, leaseVersion, expectedDiscountCodeCanonical,
      (lockedAt > DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 5 MINUTE)) AS live
    FROM WeleticShopifyVoucherCleanup WHERE id = ${proof.cleanupId} LIMIT 1 FOR UPDATE
  `);
  if (
    !lease ||
    lease.storeId !== store.id ||
    lease.redemptionId !== proof.redemptionId ||
    lease.source !== proof.source ||
    lease.status !== "processing" ||
    lease.lockedBy !== proof.lockOwner ||
    lease.leaseVersion !== proof.leaseVersion ||
    !Number(lease.live) ||
    lease.expectedDiscountCodeCanonical !== proof.expectedCode
  )
    throw new ShopifyCredentialUnavailableError(
      "Frozen voucher cleanup lease changed",
    );
  const requests = await tx.$queryRaw<
    Array<{
      requestType: string;
      shopDomain: string;
      payloadCiphertext: string | null;
    }>
  >(Prisma.sql`
    SELECT r.requestType, r.shopDomain, r.payloadCiphertext
    FROM WeleticShopifyVoucherCleanupRequestLink l
    JOIN WeleticShopifyComplianceRequest r ON r.id = l.requestId AND r.storeId = l.storeId
    WHERE l.storeId = ${store.id} AND l.cleanupId = ${proof.cleanupId}
      AND r.requestType = ${proof.source} AND r.status IN ('pending', 'processing', 'retrying')
      AND r.phase IN ('enumerate_vouchers', 'voucher_cleanup')
    ORDER BY r.createdAt DESC LIMIT 20 FOR UPDATE
  `);
  const authorized = requests.some((request) => {
    if (request.shopDomain !== identity.shop) return false;
    // An unfinished shop-redaction request itself blocks every reinstall.
    if (request.requestType === "shop_redact") return true;
    try {
      const subject = JSON.parse(decrypt(request.payloadCiphertext || ""));
      return (
        subject.shopDomain === identity.shop &&
        subject.installationGeneration === identity.installationGeneration
      );
    } catch {
      return false;
    }
  });
  if (!authorized)
    throw new ShopifyCredentialUnavailableError(
      "Frozen voucher cleanup request is unavailable",
    );
  // Linked-request lock waits must not consume the remainder of this lease
  // and then release a credential to an already-expired worker.
  const [freshLease] = await tx.$queryRaw<
    Array<{ live: number | bigint }>
  >(Prisma.sql`
    SELECT (lockedAt > DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 5 MINUTE)) AS live
    FROM WeleticShopifyVoucherCleanup WHERE id = ${proof.cleanupId}
  `);
  if (!Number(freshLease?.live))
    throw new ShopifyCredentialUnavailableError(
      "Frozen voucher cleanup lease expired during authorization",
    );
  const material = openEnvelope(credential, identity);
  if (
    !material.scope
      .split(",")
      .map((scope) => scope.trim())
      .includes("write_discounts")
  )
    throw new ShopifyCredentialUnavailableError(
      "Frozen voucher cleanup lacks discount permission",
    );
  return {
    shopDomain: identity.shop,
    installationGeneration: identity.installationGeneration,
    ...material,
  };
}

/** Only call after verified coordinated token publication has acquired its
 * lease and checked its observation. A matching revision is not authentication.
 */
export async function publishStoreOwnedShopifyCredential(
  tx: Prisma.TransactionClient,
  input: unknown,
) {
  const options = z
    .object({
      identity: identitySchema,
      expectedRevision: z.number().int().positive().max(2147483645).nullable(),
      material: materialSchema,
    })
    .strict()
    .parse(input);
  const { identity, row } = await lockIdentity(tx, options.identity);
  if ((row?.revision ?? null) !== options.expectedRevision)
    throw new Error("Credential publication lost its revision fence");
  if (row) openEnvelope(row, identity);
  const revision = (row?.revision ?? 0) + 1;
  const ciphertext = encrypt(
    JSON.stringify({
      version: 1,
      revision,
      identity,
      material: options.material,
    }),
  );
  if (!row) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO WeleticShopifyInstallationCredential
        (id, storeId, appId, installationGeneration, revision, credentialCiphertext, createdAt, updatedAt)
      VALUES (${randomUUID()}, ${identity.storeId}, ${identity.appId}, ${identity.installationGeneration},
        ${revision}, ${ciphertext}, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
    `);
  } else {
    const count = await tx.$executeRaw(Prisma.sql`
      UPDATE WeleticShopifyInstallationCredential SET revision = ${revision}, credentialCiphertext = ${ciphertext}, updatedAt = CURRENT_TIMESTAMP(3)
      WHERE id = ${row.id} AND storeId = ${identity.storeId} AND appId = ${identity.appId}
        AND installationGeneration = ${identity.installationGeneration} AND revision = ${options.expectedRevision}
    `);
    if (count !== 1)
      throw new Error("Credential publication lost its revision fence");
  }
  return { revision };
}
