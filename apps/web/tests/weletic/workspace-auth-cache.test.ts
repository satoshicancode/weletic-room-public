import { workspaceAuthCache } from "@/lib/auth/workspace-cache";
import { WorkspaceWithUsers } from "@/lib/types";
import { beforeEach, describe, expect, it } from "vitest";

describe("Workspace Auth Micro-Cache (workspaceAuthCache)", () => {
  const mockWorkspace = {
    id: "clws_123456789",
    name: "Acme Corp",
    slug: "acme",
    logo: null,
    usage: 0,
    usageLimit: 1000,
    linksUsage: 0,
    linksLimit: 100,
    domainsLimit: 3,
    tagsLimit: 10,
    foldersLimit: 5,
    usersLimit: 5,
    aiUsage: 0,
    aiLimit: 50,
    plan: "pro",
    stripeId: "cus_123",
    billingCycleStart: 1,
    createdAt: new Date(),
    inviteCode: null,
    flags: undefined,
    store: null,
    users: [
      {
        role: "owner" as const,
        defaultFolderId: null,
      },
    ],
  } as unknown as WorkspaceWithUsers;

  beforeEach(() => {
    workspaceAuthCache.clear();
  });

  it("sets and retrieves cached workspace by ID, slug, and prefixed ID", () => {
    const userId = "usr_test123";

    workspaceAuthCache.set({
      workspace: mockWorkspace,
      userId,
      identifier: "ws_clws_123456789",
    });

    // Lookup by raw ID
    const byId = workspaceAuthCache.get({
      identifier: "clws_123456789",
      userId,
    });
    expect(byId).toBeDefined();
    expect(byId?.id).toBe("clws_123456789");
    expect(byId?.users[0].role).toBe("owner");

    // Lookup by slug
    const bySlug = workspaceAuthCache.get({
      identifier: "acme",
      userId,
    });
    expect(bySlug).toBeDefined();
    expect(bySlug?.slug).toBe("acme");

    // Lookup by prefixed ID
    const byPrefixed = workspaceAuthCache.get({
      identifier: "ws_clws_123456789",
      userId,
    });
    expect(byPrefixed).toBeDefined();
    expect(byPrefixed?.id).toBe("clws_123456789");
  });

  it("returns null for non-existent workspace or invalid input", () => {
    expect(
      workspaceAuthCache.get({ identifier: "", userId: "usr_1" }),
    ).toBeNull();
    expect(
      workspaceAuthCache.get({ identifier: "acme", userId: "" }),
    ).toBeNull();
    expect(
      workspaceAuthCache.get({ identifier: "non_existent", userId: "usr_1" }),
    ).toBeNull();
  });

  it("returns cloned objects to prevent memory pollution from machine user overrides", () => {
    const userId = "usr_test123";

    workspaceAuthCache.set({
      workspace: mockWorkspace,
      userId,
    });

    const retrieved = workspaceAuthCache.get({
      identifier: "acme",
      userId,
    });
    expect(retrieved).toBeDefined();

    // Mutate retrieved object as withWorkspace does for machine users
    if (retrieved && retrieved.users[0]) {
      retrieved.users[0].role = "member";
    }

    // Next get must still return the pristine original "owner" role
    const fresh = workspaceAuthCache.get({
      identifier: "acme",
      userId,
    });
    expect(fresh?.users[0].role).toBe("owner");
  });

  it("invalidates specific user entry via delete()", () => {
    const user1 = "usr_1";
    const user2 = "usr_2";

    workspaceAuthCache.set({ workspace: mockWorkspace, userId: user1 });
    workspaceAuthCache.set({ workspace: mockWorkspace, userId: user2 });

    expect(
      workspaceAuthCache.get({ identifier: "acme", userId: user1 }),
    ).toBeDefined();
    expect(
      workspaceAuthCache.get({ identifier: "acme", userId: user2 }),
    ).toBeDefined();

    workspaceAuthCache.delete({
      workspaceId: mockWorkspace.id,
      workspaceSlug: mockWorkspace.slug,
      userId: user1,
    });

    expect(
      workspaceAuthCache.get({ identifier: "acme", userId: user1 }),
    ).toBeNull();
    expect(
      workspaceAuthCache.get({ identifier: "acme", userId: user2 }),
    ).toBeDefined();
  });

  it("invalidates all workspace entries via deleteByWorkspace()", () => {
    const user1 = "usr_1";
    const user2 = "usr_2";

    workspaceAuthCache.set({ workspace: mockWorkspace, userId: user1 });
    workspaceAuthCache.set({ workspace: mockWorkspace, userId: user2 });

    workspaceAuthCache.deleteByWorkspace({
      workspaceId: mockWorkspace.id,
      workspaceSlug: mockWorkspace.slug,
    });

    expect(
      workspaceAuthCache.get({ identifier: "acme", userId: user1 }),
    ).toBeNull();
    expect(
      workspaceAuthCache.get({ identifier: "acme", userId: user2 }),
    ).toBeNull();
  });

  it("invalidates user entries across workspaces via deleteByUser()", () => {
    const user1 = "usr_1";
    const otherWorkspace: WorkspaceWithUsers = {
      ...mockWorkspace,
      id: "clws_987654321",
      slug: "beta-corp",
    };

    workspaceAuthCache.set({ workspace: mockWorkspace, userId: user1 });
    workspaceAuthCache.set({ workspace: otherWorkspace, userId: user1 });

    expect(
      workspaceAuthCache.get({ identifier: "acme", userId: user1 }),
    ).toBeDefined();
    expect(
      workspaceAuthCache.get({ identifier: "beta-corp", userId: user1 }),
    ).toBeDefined();

    workspaceAuthCache.deleteByUser({ userId: user1 });

    expect(
      workspaceAuthCache.get({ identifier: "acme", userId: user1 }),
    ).toBeNull();
    expect(
      workspaceAuthCache.get({ identifier: "beta-corp", userId: user1 }),
    ).toBeNull();
  });

  it("tracks size and clears entries cleanly", () => {
    workspaceAuthCache.set({ workspace: mockWorkspace, userId: "u1" });
    expect(workspaceAuthCache.size).toBeGreaterThan(0);

    workspaceAuthCache.clear();
    expect(workspaceAuthCache.size).toBe(0);
  });
});
