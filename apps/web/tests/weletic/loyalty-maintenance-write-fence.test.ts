import {
  assertLoyaltyMaintenanceBaselineMetadata,
  assertLoyaltyMaintenanceWriteAllowed,
  createAuthenticatedFixtureCustomerCreateMaintenancePermit,
  createExpiredLoyaltyMaintenanceLeaseTakeoverMetadata,
  createLoyaltyMaintenanceLeaseMetadata,
  createLoyaltyMaintenanceOwnerPermit,
  LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG,
  LOYALTY_MAINTENANCE_METADATA_KEY,
  LoyaltyMaintenanceBlockedError,
  readLoyaltyMaintenanceFixtureCustomerOwnership,
  readLoyaltyMaintenanceLease,
  removeLoyaltyMaintenanceLeaseMetadata,
  takeOverExpiredLoyaltyMaintenanceLeaseWithCas,
  type LoyaltyMaintenancePermit,
} from "@/lib/weletic/loyalty/maintenance-write-fence";
import {
  assertLockedLoyaltyProgramActive,
  isLockedLoyaltyProgramActive,
  lockLoyaltyProgramRow,
} from "@/lib/weletic/loyalty/program-write-fence";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

const STORE_ID = "store_a1_staging";
const OWNER_TOKEN = "owner-token-0123456789abcdef0123456789abcdef";
const RUN_MARKER = "weletic-a1-0123456789abcdef";
const FIXTURE_EMAILS = [
  `${RUN_MARKER}-advocate@example.com`,
  `${RUN_MARKER}-privacy@example.com`,
];
const ACQUIRED_AT = new Date("2026-08-31T00:00:00.000Z");
const RECOVERY_AFTER = new Date("2026-08-31T00:30:00.000Z");

function leaseMetadata(
  existingMetadata: Prisma.JsonValue | null = {
    retained: { enabled: true },
  },
) {
  return createLoyaltyMaintenanceLeaseMetadata({
    existingMetadata,
    ownerToken: OWNER_TOKEN,
    runMarker: RUN_MARKER,
    fixtureEmails: FIXTURE_EMAILS,
    acquiredAt: ACQUIRED_AT,
    recoveryAfter: RECOVERY_AFTER,
  });
}

describe("loyalty maintenance metadata and permits", () => {
  it("stores only digests and timestamps while preserving retained metadata", () => {
    const metadata = leaseMetadata();
    const lease = readLoyaltyMaintenanceLease(
      metadata as unknown as Prisma.JsonValue,
    );

    expect(metadata.retained).toEqual({ enabled: true });
    expect(lease).toMatchObject({
      acquiredAt: ACQUIRED_AT.toISOString(),
      recoveryAfter: RECOVERY_AFTER.toISOString(),
    });
    expect(lease?.fixtureEmailSha256).toHaveLength(2);
    const serializedLease = JSON.stringify(
      metadata[LOYALTY_MAINTENANCE_METADATA_KEY],
    );
    expect(serializedLease).not.toContain(OWNER_TOKEN);
    expect(serializedLease).not.toContain(RUN_MARKER);
    expect(serializedLease).not.toContain(FIXTURE_EMAILS[0]);
    expect(serializedLease).not.toContain(
      LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG,
    );
    expect(serializedLease.match(/[a-f0-9]{64}/g)?.length).toBe(6);
  });

  it("keeps the lease blocking after recoveryAfter until exact owner release", () => {
    const metadata = createLoyaltyMaintenanceLeaseMetadata({
      existingMetadata: null,
      ownerToken: OWNER_TOKEN,
      runMarker: RUN_MARKER,
      fixtureEmails: FIXTURE_EMAILS,
      acquiredAt: new Date("2020-01-01T00:00:00.000Z"),
      recoveryAfter: new Date("2020-01-01T00:01:00.000Z"),
    });

    expect(() =>
      assertLoyaltyMaintenanceWriteAllowed({
        storeId: STORE_ID,
        metadata: metadata as unknown as Prisma.JsonValue,
      }),
    ).toThrow(LoyaltyMaintenanceBlockedError);
  });

  it("takes over only an expired generation and preserves every ownership proof", () => {
    const retainedMetadata = { retained: { enabled: true } };
    const metadata = leaseMetadata(retainedMetadata);
    const oldPermit = createLoyaltyMaintenanceOwnerPermit({
      storeId: STORE_ID,
      metadata: metadata as unknown as Prisma.JsonValue,
      ownerToken: OWNER_TOKEN,
    });
    const recoveryToken = "recovery-token-0123456789abcdef0123456789abcdef";
    const nextRecoveryAfter = new Date("2026-08-31T01:00:00.000Z");
    const takenOver = createExpiredLoyaltyMaintenanceLeaseTakeoverMetadata({
      existingMetadata: metadata as unknown as Prisma.JsonValue,
      newOwnerToken: recoveryToken,
      now: RECOVERY_AFTER,
      recoveryAfter: nextRecoveryAfter,
    });
    const previousLease = readLoyaltyMaintenanceLease(
      metadata as unknown as Prisma.JsonValue,
    );
    const nextLease = readLoyaltyMaintenanceLease(
      takenOver as unknown as Prisma.JsonValue,
    );

    expect(takenOver.retained).toEqual(retainedMetadata.retained);
    expect(nextLease).toMatchObject({
      acquiredAt: previousLease?.acquiredAt,
      baselineMetadataSha256: previousLease?.baselineMetadataSha256,
      fixtureDisposableTagSha256: previousLease?.fixtureDisposableTagSha256,
      fixtureEmailSha256: previousLease?.fixtureEmailSha256,
      fixtureRunMarkerTagSha256: previousLease?.fixtureRunMarkerTagSha256,
      recoveryAfter: nextRecoveryAfter.toISOString(),
    });
    expect(nextLease?.ownerTokenSha256).not.toBe(
      previousLease?.ownerTokenSha256,
    );
    expect(JSON.stringify(takenOver)).not.toContain(recoveryToken);
    expect(() =>
      assertLoyaltyMaintenanceWriteAllowed({
        storeId: STORE_ID,
        metadata: takenOver as unknown as Prisma.JsonValue,
        permit: oldPermit,
      }),
    ).toThrow(LoyaltyMaintenanceBlockedError);
    const recoveryPermit = createLoyaltyMaintenanceOwnerPermit({
      storeId: STORE_ID,
      metadata: takenOver as unknown as Prisma.JsonValue,
      ownerToken: recoveryToken,
    });
    expect(
      removeLoyaltyMaintenanceLeaseMetadata({
        existingMetadata: takenOver as unknown as Prisma.JsonValue,
        permit: recoveryPermit,
      }),
    ).toEqual(retainedMetadata);
  });

  it("refuses takeover before expiry, non-future recovery, and token reuse", () => {
    const metadata = leaseMetadata();
    const base = {
      existingMetadata: metadata as unknown as Prisma.JsonValue,
      newOwnerToken: "recovery-token-0123456789abcdef0123456789abcdef",
      recoveryAfter: new Date("2026-08-31T01:00:00.000Z"),
    };
    expect(() =>
      createExpiredLoyaltyMaintenanceLeaseTakeoverMetadata({
        ...base,
        now: new Date(RECOVERY_AFTER.getTime() - 1),
      }),
    ).toThrow(LoyaltyMaintenanceBlockedError);
    expect(() =>
      createExpiredLoyaltyMaintenanceLeaseTakeoverMetadata({
        ...base,
        now: RECOVERY_AFTER,
        recoveryAfter: RECOVERY_AFTER,
      }),
    ).toThrow(LoyaltyMaintenanceBlockedError);
    expect(() =>
      createExpiredLoyaltyMaintenanceLeaseTakeoverMetadata({
        ...base,
        newOwnerToken: OWNER_TOKEN,
        now: RECOVERY_AFTER,
      }),
    ).toThrow(LoyaltyMaintenanceBlockedError);
  });

  it("verifies baseline metadata and exact fixture ownership without disclosing it", () => {
    const retainedMetadata = { retained: { enabled: true } };
    const metadata = leaseMetadata(retainedMetadata);
    expect(() =>
      assertLoyaltyMaintenanceBaselineMetadata({
        baselineMetadata: retainedMetadata,
        leaseMetadata: metadata as unknown as Prisma.JsonValue,
      }),
    ).not.toThrow();
    expect(() =>
      assertLoyaltyMaintenanceBaselineMetadata({
        baselineMetadata: { retained: { enabled: false } },
        leaseMetadata: metadata as unknown as Prisma.JsonValue,
      }),
    ).toThrow(LoyaltyMaintenanceBlockedError);
    expect(
      readLoyaltyMaintenanceFixtureCustomerOwnership({
        metadata: metadata as unknown as Prisma.JsonValue,
        email: FIXTURE_EMAILS[0],
        tags: [LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG, RUN_MARKER],
      }),
    ).toEqual({
      owned: true,
      partialMatch: false,
      runMarkerTag: RUN_MARKER,
    });
    expect(
      readLoyaltyMaintenanceFixtureCustomerOwnership({
        metadata: metadata as unknown as Prisma.JsonValue,
        email: "different@example.com",
        tags: [LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG, RUN_MARKER],
      }),
    ).toMatchObject({ owned: false, partialMatch: true });
  });

  it("creates an exact-store owner permit and rejects wrong credentials", () => {
    const metadata = leaseMetadata();
    const permit = createLoyaltyMaintenanceOwnerPermit({
      storeId: STORE_ID,
      metadata: metadata as unknown as Prisma.JsonValue,
      ownerToken: OWNER_TOKEN,
    });

    expect(() =>
      assertLoyaltyMaintenanceWriteAllowed({
        storeId: STORE_ID,
        metadata: metadata as unknown as Prisma.JsonValue,
        permit,
      }),
    ).not.toThrow();
    expect(() =>
      assertLoyaltyMaintenanceWriteAllowed({
        storeId: "another_store",
        metadata: metadata as unknown as Prisma.JsonValue,
        permit,
      }),
    ).toThrow(LoyaltyMaintenanceBlockedError);
    expect(() =>
      createLoyaltyMaintenanceOwnerPermit({
        storeId: STORE_ID,
        metadata: metadata as unknown as Prisma.JsonValue,
        ownerToken: "wrong-token-0123456789abcdef0123456789abcdef",
      }),
    ).toThrow(LoyaltyMaintenanceBlockedError);
  });

  it("rejects an owner permit replay after its lease is released", () => {
    const metadata = leaseMetadata();
    const permit = createLoyaltyMaintenanceOwnerPermit({
      storeId: STORE_ID,
      metadata: metadata as unknown as Prisma.JsonValue,
      ownerToken: OWNER_TOKEN,
    });
    const releasedMetadata = removeLoyaltyMaintenanceLeaseMetadata({
      existingMetadata: metadata as unknown as Prisma.JsonValue,
      permit,
    });

    expect(() =>
      assertLoyaltyMaintenanceWriteAllowed({
        storeId: STORE_ID,
        metadata: releasedMetadata as Prisma.JsonValue,
      }),
    ).not.toThrow();
    expect(() =>
      assertLoyaltyMaintenanceWriteAllowed({
        storeId: STORE_ID,
        metadata: releasedMetadata as Prisma.JsonValue,
        permit,
      }),
    ).toThrow(LoyaltyMaintenanceBlockedError);
  });

  it("authorizes only an authenticated exact fixture customers/create", () => {
    const metadata = leaseMetadata();
    const createPermit = (
      overrides: {
        topic?: string;
        webhookAuthenticated?: boolean;
        email?: string;
        tags?: string | string[];
      } = {},
    ) =>
      createAuthenticatedFixtureCustomerCreateMaintenancePermit({
        storeId: STORE_ID,
        metadata: metadata as unknown as Prisma.JsonValue,
        topic: overrides.topic ?? "customers/create",
        webhookAuthenticated: overrides.webhookAuthenticated ?? true,
        email: overrides.email ?? FIXTURE_EMAILS[0],
        tags: overrides.tags ?? [
          LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG,
          RUN_MARKER,
        ],
      });

    const permit = createPermit();
    expect(permit.authorization).toBe("fixture_customer_create");
    expect(() =>
      assertLoyaltyMaintenanceWriteAllowed({
        storeId: STORE_ID,
        metadata: metadata as unknown as Prisma.JsonValue,
        permit,
      }),
    ).not.toThrow();

    expect(() => createPermit({ webhookAuthenticated: false })).toThrow(
      LoyaltyMaintenanceBlockedError,
    );
    expect(() => createPermit({ topic: "customers/update" })).toThrow(
      LoyaltyMaintenanceBlockedError,
    );
    expect(() => createPermit({ email: "nonfixture@example.com" })).toThrow(
      LoyaltyMaintenanceBlockedError,
    );
    expect(() => createPermit({ tags: [RUN_MARKER] })).toThrow(
      LoyaltyMaintenanceBlockedError,
    );
    expect(() =>
      createPermit({
        tags: [LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG],
      }),
    ).toThrow(LoyaltyMaintenanceBlockedError);
  });

  it("rejects a fixture permit replay after its lease is released", () => {
    const metadata = leaseMetadata();
    const fixturePermit =
      createAuthenticatedFixtureCustomerCreateMaintenancePermit({
        storeId: STORE_ID,
        metadata: metadata as unknown as Prisma.JsonValue,
        topic: "customers/create",
        webhookAuthenticated: true,
        email: FIXTURE_EMAILS[0],
        tags: [LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG, RUN_MARKER],
      });
    const ownerPermit = createLoyaltyMaintenanceOwnerPermit({
      storeId: STORE_ID,
      metadata: metadata as unknown as Prisma.JsonValue,
      ownerToken: OWNER_TOKEN,
    });
    const releasedMetadata = removeLoyaltyMaintenanceLeaseMetadata({
      existingMetadata: metadata as unknown as Prisma.JsonValue,
      permit: ownerPermit,
    });

    expect(() =>
      assertLoyaltyMaintenanceWriteAllowed({
        storeId: STORE_ID,
        metadata: releasedMetadata as Prisma.JsonValue,
        permit: fixturePermit,
      }),
    ).toThrow(LoyaltyMaintenanceBlockedError);
  });

  it("invalidates a permit when any lease generation field changes", () => {
    const metadata = leaseMetadata();
    const permit = createLoyaltyMaintenanceOwnerPermit({
      storeId: STORE_ID,
      metadata: metadata as unknown as Prisma.JsonValue,
      ownerToken: OWNER_TOKEN,
    });
    const changedMetadata = structuredClone(metadata) as Record<
      string,
      unknown
    >;
    const changedLease = changedMetadata[
      LOYALTY_MAINTENANCE_METADATA_KEY
    ] as Record<string, unknown>;
    changedLease.recoveryAfter = "2026-08-31T00:31:00.000Z";

    expect(() =>
      assertLoyaltyMaintenanceWriteAllowed({
        storeId: STORE_ID,
        metadata: changedMetadata as Prisma.JsonObject,
        permit,
      }),
    ).toThrow(LoyaltyMaintenanceBlockedError);
  });

  it("rejects structurally forged permits and malformed reserved metadata", () => {
    const metadata = leaseMetadata();
    const forgedPermit = {
      authorization: "owner_token",
      leaseSha256: "a".repeat(64),
      storeId: STORE_ID,
    } as unknown as LoyaltyMaintenancePermit;
    expect(() =>
      assertLoyaltyMaintenanceWriteAllowed({
        storeId: STORE_ID,
        metadata: metadata as unknown as Prisma.JsonValue,
        permit: forgedPermit,
      }),
    ).toThrow(LoyaltyMaintenanceBlockedError);
    expect(() =>
      readLoyaltyMaintenanceLease({
        [LOYALTY_MAINTENANCE_METADATA_KEY]: {
          ownerTokenSha256: "not-a-digest",
        },
      }),
    ).toThrow(LoyaltyMaintenanceBlockedError);
  });

  it("removes only the exact lease and restores object or null metadata", () => {
    const retainedMetadata = { retained: { enabled: true } };
    const metadata = leaseMetadata(retainedMetadata);
    const permit = createLoyaltyMaintenanceOwnerPermit({
      storeId: STORE_ID,
      metadata: metadata as unknown as Prisma.JsonValue,
      ownerToken: OWNER_TOKEN,
    });
    expect(
      removeLoyaltyMaintenanceLeaseMetadata({
        existingMetadata: metadata as unknown as Prisma.JsonValue,
        permit,
      }),
    ).toEqual(retainedMetadata);

    const nullBaseline = leaseMetadata(null);
    const nullPermit = createLoyaltyMaintenanceOwnerPermit({
      storeId: STORE_ID,
      metadata: nullBaseline as unknown as Prisma.JsonValue,
      ownerToken: OWNER_TOKEN,
    });
    expect(
      removeLoyaltyMaintenanceLeaseMetadata({
        existingMetadata: nullBaseline as unknown as Prisma.JsonValue,
        permit: nullPermit,
      }),
    ).toBe(Prisma.DbNull);
  });

  it("refuses lease removal after retained metadata drift", () => {
    const metadata = leaseMetadata() as Record<string, unknown>;
    const permit = createLoyaltyMaintenanceOwnerPermit({
      storeId: STORE_ID,
      metadata: metadata as Prisma.JsonObject,
      ownerToken: OWNER_TOKEN,
    });
    metadata.retained = { enabled: false };

    expect(() =>
      removeLoyaltyMaintenanceLeaseMetadata({
        existingMetadata: metadata as Prisma.JsonObject,
        permit,
      }),
    ).toThrow(LoyaltyMaintenanceBlockedError);
  });

  it("allows only an owner-token permit to remove the lease", () => {
    const metadata = leaseMetadata();
    const fixturePermit =
      createAuthenticatedFixtureCustomerCreateMaintenancePermit({
        storeId: STORE_ID,
        metadata: metadata as unknown as Prisma.JsonValue,
        topic: "customers/create",
        webhookAuthenticated: true,
        email: FIXTURE_EMAILS[0],
        tags: [LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG, RUN_MARKER],
      });

    expect(() =>
      removeLoyaltyMaintenanceLeaseMetadata({
        existingMetadata: metadata as unknown as Prisma.JsonValue,
        permit: fixturePermit,
      }),
    ).toThrow(LoyaltyMaintenanceBlockedError);
  });

  it("takes over with store-to-program locks and an exact current-row CAS", async () => {
    const metadata = leaseMetadata();
    const expectedUpdatedAt = new Date("2026-08-31T00:10:00.000Z");
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: STORE_ID }])
        .mockResolvedValueOnce([
          {
            id: "program_a1",
            storeId: STORE_ID,
            updatedAt: expectedUpdatedAt,
            metadata,
          },
        ]),
      weleticLoyaltyProgram: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as any;
    const recoveryToken = "recovery-token-0123456789abcdef0123456789abcdef";

    const result = await takeOverExpiredLoyaltyMaintenanceLeaseWithCas({
      tx,
      storeId: STORE_ID,
      programId: "program_a1",
      expectedUpdatedAt,
      expectedMetadata: metadata as unknown as Prisma.JsonValue,
      newOwnerToken: recoveryToken,
      now: RECOVERY_AFTER,
      recoveryAfter: new Date("2026-08-31T01:00:00.000Z"),
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.weleticLoyaltyProgram.updateMany).toHaveBeenCalledTimes(1);
    expect(() =>
      assertLoyaltyMaintenanceWriteAllowed({
        storeId: STORE_ID,
        metadata: result.metadata as unknown as Prisma.JsonValue,
        permit: result.permit,
      }),
    ).not.toThrow();
  });

  it("refuses a takeover when the locked current row differs from preflight", async () => {
    const metadata = leaseMetadata();
    const expectedUpdatedAt = new Date("2026-08-31T00:10:00.000Z");
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: STORE_ID }])
        .mockResolvedValueOnce([
          {
            id: "program_a1",
            storeId: STORE_ID,
            updatedAt: new Date(expectedUpdatedAt.getTime() + 1),
            metadata,
          },
        ]),
      weleticLoyaltyProgram: { updateMany: vi.fn() },
    } as any;

    await expect(
      takeOverExpiredLoyaltyMaintenanceLeaseWithCas({
        tx,
        storeId: STORE_ID,
        programId: "program_a1",
        expectedUpdatedAt,
        expectedMetadata: metadata as unknown as Prisma.JsonValue,
        newOwnerToken: "recovery-token-0123456789abcdef0123456789abcdef",
        now: RECOVERY_AFTER,
        recoveryAfter: new Date("2026-08-31T01:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(LoyaltyMaintenanceBlockedError);
    expect(tx.weleticLoyaltyProgram.updateMany).not.toHaveBeenCalled();
  });
});

describe("loyalty program row maintenance enforcement", () => {
  it("blocks an active-mode program lock without a permit", async () => {
    const metadata = leaseMetadata();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          id: "program_a1",
          storeId: STORE_ID,
          status: "active",
          killSwitchActive: false,
          metadata,
        },
      ]),
    } as any;

    await expect(
      lockLoyaltyProgramRow({ tx, storeId: STORE_ID, mode: "active" }),
    ).rejects.toBeInstanceOf(LoyaltyMaintenanceBlockedError);
  });

  it("allows only the exact permit and keeps ordinary active checks intact", async () => {
    const metadata = leaseMetadata();
    const permit = createLoyaltyMaintenanceOwnerPermit({
      storeId: STORE_ID,
      metadata: metadata as unknown as Prisma.JsonValue,
      ownerToken: OWNER_TOKEN,
    });
    const program = {
      id: "program_a1",
      storeId: STORE_ID,
      status: "active",
      killSwitchActive: false,
      metadata: metadata as unknown as Prisma.JsonValue,
    };
    const tx = { $queryRaw: vi.fn().mockResolvedValue([program]) } as any;

    await expect(
      lockLoyaltyProgramRow({
        tx,
        storeId: STORE_ID,
        mode: "active",
        loyaltyMaintenancePermit: permit,
      }),
    ).resolves.toMatchObject({ id: "program_a1" });
    expect(isLockedLoyaltyProgramActive(program)).toBe(false);
    expect(isLockedLoyaltyProgramActive(program, permit)).toBe(true);
    expect(() => assertLockedLoyaltyProgramActive(program)).toThrow(
      LoyaltyMaintenanceBlockedError,
    );
    expect(() =>
      assertLockedLoyaltyProgramActive(
        { ...program, killSwitchActive: true },
        permit,
      ),
    ).toThrow("disabled or inactive");
  });
});
