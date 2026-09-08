import { decrypt, encrypt } from "@/lib/encryption";
import { createPlainThread } from "@/lib/plain/create-plain-thread";
import { prisma } from "@/lib/prisma";
import { storage } from "@/lib/storage";
import { createWeleticId } from "@/lib/weletic/ids";
import { getShopifyComplianceExportRetentionHours } from "@/lib/weletic/shopify/compliance-config";
import { deriveAllShopifyCustomerPrivacyIdentities } from "@/lib/weletic/shopify/privacy-identity";
import { APP_DOMAIN_WITH_NGROK } from "@dub/utils";
import { Prisma } from "@prisma/client";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ARTIFACT_ENCRYPTION_VERSION = "aes-256-gcm:v1";
const DOWNLOAD_TOKEN_VERSION = "random-256:aes-256-gcm:v1";
const MANIFEST_KIND = "manifest";
const UPLOAD_CLEANUP_KIND_PREFIX = "upload_cleanup:";
const UPLOAD_CLEANUP_GRACE_MS = 15 * 60 * 1000;
const ARTIFACT_DOWNLOAD_PAGE_SIZE = 50;

export interface ComplianceArtifactLease {
  workerId: string;
  leaseVersion: number;
}

function ownerProgress(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type ComplianceExportFenceSubject = {
  id: string;
  storeId: string;
  subjectKind: string | null;
  subjectKeyId: string | null;
  subjectDigest: string | null;
  progress: unknown;
};

async function isComplianceExportFencedByActiveRedaction({
  client,
  request,
}: {
  client: typeof prisma | Prisma.TransactionClient;
  request: ComplianceExportFenceSubject;
}) {
  const shopBlocker = await client.weleticShopifyComplianceRequest.findFirst({
    where: {
      storeId: request.storeId,
      id: { not: request.id },
      requestType: "shop_redact",
      status: { in: ["pending", "processing", "retrying", "dead_letter"] },
    },
    select: { id: true },
  });
  if (shopBlocker) return true;

  // A rotation can leave an older pending data request with a previous-key
  // digest and no resolved owner progress. Inspect the bounded active
  // redaction set and derive every configured key version from its encrypted
  // raw subject. Any malformed/oversized active set fails closed.
  const customerRedactions =
    await client.weleticShopifyComplianceRequest.findMany({
      where: {
        storeId: request.storeId,
        id: { not: request.id },
        requestType: "customer_redact",
        status: { in: ["pending", "processing", "retrying", "dead_letter"] },
      },
      orderBy: { receivedAt: "asc" },
      take: 51,
      select: {
        subjectKind: true,
        subjectKeyId: true,
        subjectDigest: true,
        payloadCiphertext: true,
        progress: true,
      },
    });
  if (customerRedactions.length > 50) return true;

  const owner = ownerProgress(request.progress);
  const ownerKeys = [
    "ownerShopperId",
    "ownerAccountId",
    "ownerLegacyCustomerId",
  ] as const;
  const requestHasDigestIdentity = Boolean(
    request.subjectKind && request.subjectKeyId && request.subjectDigest,
  );
  const requestHasOwnerIdentity = ownerKeys.some(
    (key) => typeof owner[key] === "string" && Boolean(owner[key]),
  );
  // Completion intentionally scrubs request subject HMACs. If no bounded
  // internal owner survived either, an unresolved customer redaction cannot
  // be proven unrelated. Fail closed store-wide instead of leaving a bearer
  // usable during an ambiguous privacy request.
  if (
    customerRedactions.length > 0 &&
    !requestHasDigestIdentity &&
    !requestHasOwnerIdentity
  ) {
    return true;
  }
  const ownerMatches = (candidate: unknown) => {
    const candidateOwner = ownerProgress(candidate);
    return ownerKeys.some(
      (key) =>
        typeof owner[key] === "string" && owner[key] === candidateOwner[key],
    );
  };
  return customerRedactions.some((redaction) => {
    const redactionOwner = ownerProgress(redaction.progress);
    const redactionHasOwnerIdentity = ownerKeys.some(
      (key) =>
        typeof redactionOwner[key] === "string" && Boolean(redactionOwner[key]),
    );
    const redactionHasDigestIdentity = Boolean(
      redaction.subjectKind &&
        redaction.subjectKeyId &&
        redaction.subjectDigest,
    );
    if (
      !redactionHasOwnerIdentity &&
      !redactionHasDigestIdentity &&
      !redaction.payloadCiphertext
    ) {
      return true;
    }
    if (
      request.subjectKind &&
      request.subjectKeyId &&
      request.subjectDigest &&
      redaction.subjectKind === request.subjectKind &&
      redaction.subjectKeyId === request.subjectKeyId &&
      redaction.subjectDigest === request.subjectDigest
    ) {
      return true;
    }
    if (ownerMatches(redaction.progress)) return true;
    const sharedOwnerKeys = ownerKeys.filter(
      (key) =>
        typeof owner[key] === "string" &&
        Boolean(owner[key]) &&
        typeof redactionOwner[key] === "string" &&
        Boolean(redactionOwner[key]),
    );
    const hasComparableOwnerChannel = sharedOwnerKeys.length > 0;
    const hasComparableDigestChannel =
      requestHasDigestIdentity && redactionHasDigestIdentity;
    if (!hasComparableOwnerChannel && !hasComparableDigestChannel) {
      return true;
    }
    // A shared stable internal owner key is authoritative. Merely having
    // different owner *kinds* is not comparable: a legacy-customer-only export
    // and shopper-only redaction may still represent the same person.
    if (hasComparableOwnerChannel) return false;
    if (!redaction.payloadCiphertext || !request.subjectDigest) {
      // Same key/kind with unequal digests is conclusive. Different key
      // versions require the encrypted raw redaction subject for rotation-aware
      // comparison; without it, fail closed.
      return !(
        request.subjectKind === redaction.subjectKind &&
        request.subjectKeyId === redaction.subjectKeyId
      );
    }
    try {
      const subject = JSON.parse(decrypt(redaction.payloadCiphertext)) as {
        customerId?: string;
        customerEmail?: string;
      };
      return deriveAllShopifyCustomerPrivacyIdentities({
        storeId: request.storeId,
        shopifyCustomerId: subject.customerId,
        email: subject.customerEmail,
      }).some(
        (identity) =>
          identity.identityKind === request.subjectKind &&
          identity.identityKeyId === request.subjectKeyId &&
          identity.customerDigest === request.subjectDigest,
      );
    } catch {
      return true;
    }
  });
}

async function assertComplianceArtifactWriteLease({
  client,
  requestId,
  storeId,
  lease,
}: {
  client: typeof prisma | Prisma.TransactionClient;
  requestId: string;
  storeId: string;
  lease: ComplianceArtifactLease;
}) {
  const request = await client.weleticShopifyComplianceRequest.findFirst({
    where: {
      id: requestId,
      storeId,
      requestType: "customer_data_request",
      status: "processing",
      lockedBy: lease.workerId,
      leaseVersion: lease.leaseVersion,
    },
    select: {
      id: true,
      storeId: true,
      subjectKind: true,
      subjectKeyId: true,
      subjectDigest: true,
      progress: true,
      store: { select: { complianceState: true } },
    },
  });
  if (!request || request.store.complianceState === "redacted") {
    throw new Error("Compliance export write lease is no longer valid.");
  }

  if (await isComplianceExportFencedByActiveRedaction({ client, request })) {
    throw new Error("Compliance export is fenced by an active redaction.");
  }
}

function assertPrivateComplianceStorageConfigured() {
  const required = [
    "STORAGE_ENDPOINT",
    "STORAGE_PRIVATE_BUCKET",
    "STORAGE_ACCESS_KEY_ID",
    "STORAGE_SECRET_ACCESS_KEY",
  ] as const;
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Private compliance storage is unavailable: ${missing.join(", ")} must be configured.`,
    );
  }
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonStringify(value: unknown) {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function artifactStorageKey({
  storeId,
  requestId,
  kind,
  sequence,
  leaseVersion,
}: {
  storeId: string;
  requestId: string;
  kind: string;
  sequence: number;
  leaseVersion: number;
}) {
  const safeKind = kind.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  const attemptNonce = randomBytes(12).toString("hex");
  return `compliance/shopify/${storeId}/${requestId}/${safeKind}-${sequence}-lease-${leaseVersion}-${attemptNonce}.json.enc`;
}

export async function storeEncryptedComplianceArtifact({
  requestId,
  storeId,
  kind,
  sequence,
  value,
  expiresAt,
  lease,
}: {
  requestId: string;
  storeId: string;
  kind: string;
  sequence: number;
  value: unknown;
  expiresAt: Date;
  lease: ComplianceArtifactLease;
}) {
  assertPrivateComplianceStorageConfigured();
  await assertComplianceArtifactWriteLease({
    client: prisma,
    requestId,
    storeId,
    lease,
  });
  const storageKey = artifactStorageKey({
    storeId,
    requestId,
    kind,
    sequence,
    leaseVersion: lease.leaseVersion,
  });
  const ciphertext = encrypt(jsonStringify(value));
  const body = Buffer.from(ciphertext, "utf8");
  const cleanupIntent = await prisma.weleticShopifyComplianceArtifact.create({
    data: {
      id: createWeleticId("wartifact_"),
      requestId,
      storeId,
      kind: `${UPLOAD_CLEANUP_KIND_PREFIX}${sha256(storageKey)}`,
      sequence: 0,
      storageKey,
      encryptionVersion: `${ARTIFACT_ENCRYPTION_VERSION};upload-cleanup:v1`,
      contentSha256: sha256(body),
      byteSize: BigInt(body.byteLength),
      expiresAt: new Date(Date.now() + UPLOAD_CLEANUP_GRACE_MS),
      lastError: "Encrypted upload cleanup is pending.",
    },
  });
  const resolveCleanupIntent = async () => {
    await prisma.weleticShopifyComplianceArtifact.updateMany({
      where: { id: cleanupIntent.id, deletedAt: null },
      data: { deletedAt: new Date(), lastError: null },
    });
  };
  const retainCleanupIntent = async (message: string) => {
    await prisma.weleticShopifyComplianceArtifact
      .updateMany({
        where: { id: cleanupIntent.id, deletedAt: null },
        data: { lastError: message },
      })
      .catch(() => undefined);
  };
  const deleteAttemptObject = async () => {
    await storage.delete({ key: storageKey, bucket: "private" });
    await resolveCleanupIntent();
  };

  try {
    await storage.upload({
      key: storageKey,
      body,
      bucket: "private",
      opts: {
        contentType: "application/octet-stream",
        headers: { "Cache-Control": "private, no-store" },
      },
    });
  } catch (error) {
    // PUT may have committed remotely before the client observed its failure.
    // The cleanup intent was persisted first, so a failed immediate delete is
    // retried by the bounded expiry sweeper.
    await deleteAttemptObject().catch(async () => {
      await retainCleanupIntent("Encrypted upload cleanup must be retried.");
    });
    throw error;
  }

  try {
    const publication = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM WeleticShopifyComplianceRequest WHERE id = ${requestId} FOR UPDATE`,
      );
      await assertComplianceArtifactWriteLease({
        client: tx,
        requestId,
        storeId,
        lease,
      });
      const existing = await tx.weleticShopifyComplianceArtifact.findUnique({
        where: {
          requestId_kind_sequence: { requestId, kind, sequence },
        },
      });
      if (existing) {
        // Keep the cleanup intent live until the losing unique object has
        // actually been deleted. Resolving it here would orphan that object
        // if the worker crashed or the storage delete failed.
        return { artifact: existing, published: false } as const;
      }
      const consumedIntent =
        await tx.weleticShopifyComplianceArtifact.updateMany({
          where: {
            id: cleanupIntent.id,
            deletedAt: null,
            // Only the pristine pre-upload generation can become an
            // authoritative artifact. Once any delete was attempted, even an
            // uncertain "failed" response may mean the object is already
            // gone, so publication must remain permanently fenced.
            lastError: "Encrypted upload cleanup is pending.",
          },
          data: { deletedAt: new Date(), lastError: null },
        });
      if (consumedIntent.count !== 1) {
        throw new Error(
          "Compliance artifact upload cleanup was already claimed.",
        );
      }
      const artifact = await tx.weleticShopifyComplianceArtifact.create({
        data: {
          id: createWeleticId("wartifact_"),
          requestId,
          storeId,
          kind,
          sequence,
          storageKey,
          encryptionVersion: ARTIFACT_ENCRYPTION_VERSION,
          contentSha256: sha256(body),
          byteSize: BigInt(body.byteLength),
          expiresAt,
        },
      });
      return { artifact, published: true } as const;
    });
    if (!publication.published) {
      // A reclaimed/newer lease has already published this logical snapshot
      // sequence. Its storage pointer is immutable; garbage-collect only this
      // attempt's unique object and reuse the winner.
      await deleteAttemptObject().catch(async () => {
        await retainCleanupIntent("Encrypted upload cleanup must be retried.");
      });
    } else {
      // The immutable artifact row is now the authoritative owner of this
      // storage key. Cancel the cleanup intent without deleting the object.
      await resolveCleanupIntent();
    }
    return publication.artifact;
  } catch (error) {
    // A transaction can commit and still surface an uncertain network result.
    // Reconcile the immutable logical pointer before deciding whether this
    // attempt's unique object is garbage. If reconciliation is unavailable,
    // retain both the object and its durable cleanup intent for the sweeper.
    let authoritative:
      | Awaited<
          ReturnType<typeof prisma.weleticShopifyComplianceArtifact.findUnique>
        >
      | undefined;
    try {
      authoritative = await prisma.weleticShopifyComplianceArtifact.findUnique({
        where: {
          requestId_kind_sequence: { requestId, kind, sequence },
        },
      });
    } catch {
      await retainCleanupIntent(
        "Encrypted upload publication reconciliation must be retried.",
      );
      throw error;
    }
    if (authoritative?.storageKey === storageKey) {
      await resolveCleanupIntent();
      return authoritative;
    }
    await deleteAttemptObject().catch(async () => {
      await retainCleanupIntent("Encrypted upload cleanup must be retried.");
    });
    throw error;
  }
}

export async function ensureComplianceExportManifest({
  requestId,
  storeId,
  shopDomain,
  lease,
}: {
  requestId: string;
  storeId: string;
  shopDomain: string;
  lease: ComplianceArtifactLease;
}) {
  await assertComplianceArtifactWriteLease({
    client: prisma,
    requestId,
    storeId,
    lease,
  });
  const existing = await prisma.weleticShopifyComplianceArtifact.findUnique({
    where: {
      requestId_kind_sequence: {
        requestId,
        kind: MANIFEST_KIND,
        sequence: 0,
      },
    },
  });
  if (existing) {
    if (existing.downloadTokenCiphertext) {
      const token = decrypt(existing.downloadTokenCiphertext);
      if (sha256(token) !== existing.downloadTokenHash) {
        throw new Error(
          "The persisted compliance download token cannot be reproduced with the active encryption key.",
        );
      }
      await prisma.weleticShopifyComplianceArtifact.updateMany({
        where: {
          requestId,
          deletedAt: null,
          expiresAt: { not: existing.expiresAt },
          NOT: { kind: { startsWith: UPLOAD_CLEANUP_KIND_PREFIX } },
        },
        data: { expiresAt: existing.expiresAt },
      });
      return { artifact: existing, token };
    }
  }

  const initialExpiresAt =
    existing?.expiresAt ??
    new Date(
      Date.now() + getShopifyComplianceExportRetentionHours() * 60 * 60 * 1000,
    );
  const token = randomBytes(32).toString("base64url");
  const artifact =
    existing ??
    (await storeEncryptedComplianceArtifact({
      requestId,
      storeId,
      kind: MANIFEST_KIND,
      sequence: 0,
      expiresAt: initialExpiresAt,
      lease,
      value: {
        format: "weletic-shopify-compliance-export",
        version: 1,
        requestId,
        shopDomain,
        assembledFromEncryptedChunks: true,
      },
    }));
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM WeleticShopifyComplianceRequest WHERE id = ${requestId} FOR UPDATE`,
    );
    await assertComplianceArtifactWriteLease({
      client: tx,
      requestId,
      storeId,
      lease,
    });
    const current = await tx.weleticShopifyComplianceArtifact.findUniqueOrThrow(
      {
        where: { id: artifact.id },
      },
    );
    if (current.downloadTokenCiphertext) {
      const persistedToken = decrypt(current.downloadTokenCiphertext);
      if (sha256(persistedToken) !== current.downloadTokenHash) {
        throw new Error(
          "The persisted compliance download token cannot be reproduced with the active encryption key.",
        );
      }
      return { artifact: current, token: persistedToken };
    }
    // A crash can leave an immutable manifest row without a published token.
    // Normal artifacts for a nonterminal request are protected from expiry
    // deletion, so a late retry must establish a fresh first-token deadline
    // instead of publishing an immediately expired bearer. Existing tokenized
    // manifests returned above retain their original immutable deadline.
    const expiresAt =
      current.expiresAt.getTime() <= Date.now()
        ? new Date(
            Date.now() +
              getShopifyComplianceExportRetentionHours() * 60 * 60 * 1000,
          )
        : current.expiresAt;
    const published = await tx.weleticShopifyComplianceArtifact.updateMany({
      where: {
        id: artifact.id,
        deletedAt: null,
        downloadTokenCiphertext: null,
      },
      data: {
        expiresAt,
        downloadTokenHash: sha256(token),
        downloadTokenCiphertext: encrypt(token),
        downloadTokenKeyId: "encryption-key:v1",
        downloadTokenExpiresAt: expiresAt,
        encryptionVersion: `${ARTIFACT_ENCRYPTION_VERSION};${DOWNLOAD_TOKEN_VERSION}`,
      },
    });
    if (published.count !== 1) {
      throw new Error("Compliance export manifest publication was fenced.");
    }
    await tx.weleticShopifyComplianceArtifact.updateMany({
      where: {
        requestId,
        deletedAt: null,
        expiresAt: { not: expiresAt },
        NOT: { kind: { startsWith: UPLOAD_CLEANUP_KIND_PREFIX } },
      },
      data: { expiresAt },
    });
    const updated = await tx.weleticShopifyComplianceArtifact.findUniqueOrThrow(
      {
        where: { id: artifact.id },
      },
    );
    return { artifact: updated, token };
  });
}

export async function deliverComplianceExportReference({
  requestId,
  storeId,
  workspaceId,
  shopDomain,
  lease,
}: {
  requestId: string;
  storeId: string;
  workspaceId: string;
  shopDomain: string;
  lease: ComplianceArtifactLease;
}) {
  const { artifact, token } = await ensureComplianceExportManifest({
    requestId,
    storeId,
    shopDomain,
    lease,
  });
  const { user } = await prisma.projectUsers.findFirstOrThrow({
    where: { projectId: workspaceId, role: "owner" },
    select: {
      user: { select: { id: true, name: true, email: true } },
    },
  });
  // Keep the bearer in the URL fragment: browsers do not send fragments to
  // HTTP servers, access logs, or referrers. The no-store landing page posts it
  // in the request body to exchange it for the authenticated download.
  const downloadUrl = `${APP_DOMAIN_WITH_NGROK}/api/shopify/compliance/exports/${requestId}#token=${encodeURIComponent(token)}`;

  // Resolve owner contact information first, then recheck the durable lease at
  // the last possible point before publishing an external reference. A
  // concurrent customer/shop redaction can revoke this lease while the worker
  // is preparing the notification.
  await assertComplianceArtifactWriteLease({
    client: prisma,
    requestId,
    storeId,
    lease,
  });

  // Retries intentionally reproduce the same token and link. If Plain accepted
  // a request but the network outcome was uncertain, a later attempt cannot
  // invalidate the reference that the owner may already have received.
  await createPlainThread({
    user: {
      id: user.id,
      name: user.name ?? "",
      email: user.email ?? "",
    },
    externalId: `weletic-shopify-compliance-export:${requestId}`,
    title: "Shopify customer data export ready",
    components: [
      ["Compliance request", requestId],
      ["Private export (expires)", downloadUrl],
      ["Expires at", artifact.expiresAt.toISOString()],
    ].map(([text, value]) => ({
      componentRow: {
        rowMainContent: [{ componentText: { text } }],
        rowAsideContent: [{ componentText: { text: value } }],
      },
    })),
  });

  const delivered = await prisma.weleticShopifyComplianceArtifact.updateMany({
    where: {
      id: artifact.id,
      deletedAt: null,
      request: {
        id: requestId,
        storeId,
        status: "processing",
        lockedBy: lease.workerId,
        leaseVersion: lease.leaseVersion,
      },
    },
    data: {
      deliveredAt: artifact.deliveredAt ?? new Date(),
      lastError: null,
    },
  });
  if (delivered.count !== 1) {
    // Plain may already show a stale notification, but the embedded bearer is
    // authorization-fenced by the redaction/request state and cannot expose
    // data. A retry reuses the deterministic Plain external id.
    throw new Error(
      "Compliance export delivery acknowledgement lost its request lease.",
    );
  }
  return { downloadUrl, expiresAt: artifact.expiresAt };
}

async function fetchAndDecryptArtifact(artifact: {
  storageKey: string;
  contentSha256: string;
}) {
  assertPrivateComplianceStorageConfigured();
  const signedUrl = await storage.getSignedDownloadUrl({
    key: artifact.storageKey,
    bucket: "private",
    expiresIn: 60,
  });
  const response = await fetch(signedUrl, {
    headers: { "Cache-Control": "no-store" },
  });
  if (!response.ok) {
    throw new Error(
      `Compliance artifact download failed (${response.status}).`,
    );
  }
  const ciphertext = await response.text();
  const actualHash = sha256(Buffer.from(ciphertext, "utf8"));
  const expected = Buffer.from(artifact.contentSha256, "hex");
  const actual = Buffer.from(actualHash, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Compliance artifact integrity verification failed.");
  }
  return JSON.parse(decrypt(ciphertext));
}

async function authorizeComplianceExport({
  requestId,
  token,
}: {
  requestId: string;
  token: string;
}) {
  const manifest = await prisma.weleticShopifyComplianceArtifact.findUnique({
    where: {
      requestId_kind_sequence: {
        requestId,
        kind: MANIFEST_KIND,
        sequence: 0,
      },
    },
    select: {
      id: true,
      requestId: true,
      downloadTokenHash: true,
      downloadTokenExpiresAt: true,
      expiresAt: true,
      deletedAt: true,
      storageKey: true,
      contentSha256: true,
      request: {
        select: {
          id: true,
          storeId: true,
          subjectKind: true,
          subjectKeyId: true,
          subjectDigest: true,
          progress: true,
          phase: true,
          store: { select: { complianceState: true } },
        },
      },
    },
  });
  if (
    !manifest ||
    manifest.deletedAt ||
    !manifest.downloadTokenHash ||
    !manifest.downloadTokenExpiresAt ||
    manifest.downloadTokenExpiresAt <= new Date() ||
    manifest.expiresAt <= new Date() ||
    manifest.request.store.complianceState === "redacted" ||
    manifest.request.phase.startsWith("superseded_by_")
  ) {
    return null;
  }

  const expected = Buffer.from(manifest.downloadTokenHash, "hex");
  const actual = Buffer.from(sha256(token), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  if (
    await isComplianceExportFencedByActiveRedaction({
      client: prisma,
      request: manifest.request,
    })
  ) {
    return null;
  }

  return manifest;
}

async function assertComplianceExportStillReadable(requestId: string) {
  const request = await prisma.weleticShopifyComplianceRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      storeId: true,
      subjectKind: true,
      subjectKeyId: true,
      subjectDigest: true,
      progress: true,
      phase: true,
      store: { select: { complianceState: true } },
    },
  });
  if (
    !request ||
    request.store.complianceState === "redacted" ||
    request.phase.startsWith("superseded_by_")
  ) {
    throw new Error("Compliance export access has been revoked.");
  }
  if (
    await isComplianceExportFencedByActiveRedaction({
      client: prisma,
      request,
    })
  ) {
    throw new Error("Compliance export access has been revoked.");
  }
}

async function* generateComplianceExport({
  requestId,
  manifestId,
}: {
  requestId: string;
  manifestId: string;
}) {
  yield `{"requestId":${JSON.stringify(requestId)},"chunks":[`;
  let afterId: string | undefined;
  let first = true;

  do {
    await assertComplianceExportStillReadable(requestId);
    const artifacts = await prisma.weleticShopifyComplianceArtifact.findMany({
      where: {
        requestId,
        deletedAt: null,
        NOT: { kind: { startsWith: UPLOAD_CLEANUP_KIND_PREFIX } },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: "asc" },
      take: ARTIFACT_DOWNLOAD_PAGE_SIZE,
      select: {
        id: true,
        kind: true,
        sequence: true,
        storageKey: true,
        contentSha256: true,
      },
    });
    for (const artifact of artifacts) {
      await assertComplianceExportStillReadable(requestId);
      const chunk = {
        kind: artifact.kind,
        sequence: artifact.sequence,
        data: await fetchAndDecryptArtifact(artifact),
      };
      yield `${first ? "" : ","}${jsonStringify(chunk)}`;
      first = false;
    }
    afterId =
      artifacts.length === ARTIFACT_DOWNLOAD_PAGE_SIZE
        ? artifacts.at(-1)?.id
        : undefined;
  } while (afterId);

  yield "]}";
  await prisma.weleticShopifyComplianceArtifact.update({
    where: { id: manifestId },
    data: { downloadedAt: new Date() },
  });
}

export async function createComplianceExportDownload({
  requestId,
  token,
}: {
  requestId: string;
  token: string;
}) {
  const manifest = await authorizeComplianceExport({ requestId, token });
  if (!manifest) return null;

  const encoder = new TextEncoder();
  const iterator = generateComplianceExport({
    requestId,
    manifestId: manifest.id,
  });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });

  return { body };
}

async function deleteComplianceArtifactRows(
  artifacts: Array<{ id: string; storageKey: string }>,
) {
  if (artifacts.length === 0) {
    return { selected: 0, deleted: 0, failed: 0 };
  }
  assertPrivateComplianceStorageConfigured();
  let deleted = 0;
  let failed = 0;
  for (const artifact of artifacts) {
    try {
      await storage.delete({ key: artifact.storageKey, bucket: "private" });
      const result = await prisma.weleticShopifyComplianceArtifact.updateMany({
        where: { id: artifact.id, deletedAt: null },
        data: {
          deletedAt: new Date(),
          downloadTokenHash: null,
          downloadTokenCiphertext: null,
          downloadTokenKeyId: null,
          downloadTokenExpiresAt: null,
          lastError: null,
        },
      });
      deleted += result.count;
    } catch (error) {
      failed += 1;
      await prisma.weleticShopifyComplianceArtifact.update({
        where: { id: artifact.id },
        data: {
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return { selected: artifacts.length, deleted, failed };
}

export async function deleteExpiredComplianceArtifactsBatch({
  batchSize = 50,
  now = new Date(),
}: {
  batchSize?: number;
  now?: Date;
} = {}) {
  const expired = await prisma.weleticShopifyComplianceArtifact.findMany({
    where: {
      expiresAt: { lte: now },
      deletedAt: null,
      OR: [
        { kind: { startsWith: UPLOAD_CLEANUP_KIND_PREFIX } },
        { request: { status: { in: ["completed", "dead_letter"] } } },
      ],
    },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: Math.min(100, Math.max(1, batchSize)),
    select: {
      id: true,
      requestId: true,
      kind: true,
      storageKey: true,
      expiresAt: true,
      updatedAt: true,
    },
  });
  if (expired.length === 0) {
    return { selected: 0, deleted: 0, failed: 0 };
  }
  assertPrivateComplianceStorageConfigured();
  let deleted = 0;
  let failed = 0;
  for (const artifact of expired) {
    const claimedAt = new Date();
    const claimToken = `expiry-delete:${randomBytes(12).toString("hex")}`;
    const claim = await prisma.$transaction(async (tx) => {
      const requests = await tx.$queryRaw<
        Array<{ id: string; status: string }>
      >(
        Prisma.sql`SELECT id, status FROM WeleticShopifyComplianceRequest WHERE id = ${artifact.requestId} FOR UPDATE`,
      );
      if (
        !artifact.kind.startsWith(UPLOAD_CLEANUP_KIND_PREFIX) &&
        !["completed", "dead_letter"].includes(requests[0]?.status ?? "")
      ) {
        return { claimed: false, protected: false };
      }
      if (artifact.kind.startsWith(UPLOAD_CLEANUP_KIND_PREFIX)) {
        const liveOwner = await tx.weleticShopifyComplianceArtifact.findFirst({
          where: {
            id: { not: artifact.id },
            storageKey: artifact.storageKey,
            deletedAt: null,
            NOT: { kind: { startsWith: UPLOAD_CLEANUP_KIND_PREFIX } },
          },
          select: { id: true },
        });
        if (liveOwner) {
          const cancelled =
            await tx.weleticShopifyComplianceArtifact.updateMany({
              where: {
                id: artifact.id,
                deletedAt: null,
                expiresAt: artifact.expiresAt,
                updatedAt: artifact.updatedAt,
              },
              data: { deletedAt: claimedAt, lastError: null },
            });
          return { claimed: false, protected: cancelled.count === 1 };
        }
      }
      const result = await tx.weleticShopifyComplianceArtifact.updateMany({
        where: {
          id: artifact.id,
          deletedAt: null,
          AND: [{ expiresAt: artifact.expiresAt }, { expiresAt: { lte: now } }],
          updatedAt: artifact.updatedAt,
        },
        // `deletedAt` is terminal evidence that the private object is gone.
        // Keep the row live while storage deletion is in flight. A stranded
        // claim (including an uncertain DB reset) remains selectable and can
        // be CAS-reclaimed by the next bounded sweep.
        data: { lastError: claimToken },
      });
      return { claimed: result.count === 1, protected: false };
    });
    if (claim.protected) {
      deleted += 1;
      continue;
    }
    if (!claim.claimed) continue;
    try {
      await storage.delete({ key: artifact.storageKey, bucket: "private" });
      const finalized =
        await prisma.weleticShopifyComplianceArtifact.updateMany({
          where: {
            id: artifact.id,
            deletedAt: null,
            lastError: claimToken,
          },
          data: {
            deletedAt: claimedAt,
            downloadTokenHash: null,
            downloadTokenCiphertext: null,
            downloadTokenKeyId: null,
            downloadTokenExpiresAt: null,
            lastError: null,
          },
        });
      deleted += finalized.count;
    } catch (error) {
      failed += 1;
      await prisma.weleticShopifyComplianceArtifact
        .updateMany({
          where: {
            id: artifact.id,
            deletedAt: null,
            lastError: claimToken,
          },
          data: {
            lastError:
              error instanceof Error
                ? error.message
                : "Private artifact deletion failed.",
          },
        })
        .catch(() => undefined);
    }
  }
  return { selected: expired.length, deleted, failed };
}

export async function deleteComplianceArtifactsForStoreBatch({
  storeId,
  batchSize = 20,
}: {
  storeId: string;
  batchSize?: number;
}) {
  const artifacts = await prisma.weleticShopifyComplianceArtifact.findMany({
    where: { storeId, deletedAt: null },
    orderBy: { id: "asc" },
    take: Math.min(50, Math.max(1, batchSize)),
    select: { id: true, storageKey: true },
  });
  return deleteComplianceArtifactRows(artifacts);
}

export async function deleteComplianceArtifactsForCustomerRedactionBatch({
  storeId,
  supersededPhase,
  batchSize = 20,
}: {
  storeId: string;
  supersededPhase: string;
  batchSize?: number;
}) {
  const artifacts = await prisma.weleticShopifyComplianceArtifact.findMany({
    where: {
      storeId,
      deletedAt: null,
      request: { phase: supersededPhase },
    },
    orderBy: { id: "asc" },
    take: Math.min(50, Math.max(1, batchSize)),
    select: { id: true, storageKey: true },
  });
  return deleteComplianceArtifactRows(artifacts);
}
