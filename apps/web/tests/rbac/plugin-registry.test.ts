import {
  PERMISSION_ACTIONS as DUB_PERMISSION_ACTIONS,
  ROLE_PERMISSIONS as DUB_ROLE_PERMISSIONS,
  getPermissionsByRole,
} from "@/lib/api/rbac/permissions";
import { permissionRegistry } from "@/lib/api/rbac/plugin-registry";
import {
  DUB_RESOURCE_KEYS,
  DUB_RESOURCES,
  RESOURCE_KEYS,
  RESOURCES,
} from "@/lib/api/rbac/resources";
import {
  DUB_RESOURCE_SCOPES,
  DUB_SCOPES,
  getScopesForRole,
  mapScopesToPermissions,
  SCOPES,
  validateScopesForRole,
} from "@/lib/api/tokens/scopes";
import { describe, expect, it } from "vitest";

describe("ARCH-02.2 Dynamic RBAC Plugin Registry", () => {
  it("keeps upstream Dub core definitions pristine and unpolluted", () => {
    // Upstream static lists must not contain Weletic-specific domain concepts
    expect(DUB_PERMISSION_ACTIONS).not.toContain("loyalty.read");
    expect(DUB_PERMISSION_ACTIONS).not.toContain("loyalty.write");

    expect(DUB_ROLE_PERMISSIONS.some((p) => p.action === "loyalty.read")).toBe(
      false,
    );
    expect(DUB_ROLE_PERMISSIONS.some((p) => p.action === "loyalty.write")).toBe(
      false,
    );

    expect(DUB_RESOURCE_KEYS).not.toContain("loyalty");
    expect(DUB_RESOURCES.some((r) => r.key === "loyalty")).toBe(false);

    expect(DUB_SCOPES).not.toContain("loyalty.read");
    expect(DUB_SCOPES).not.toContain("loyalty.write");
    expect(DUB_RESOURCE_SCOPES.some((s) => s.scope === "loyalty.read")).toBe(
      false,
    );
  });

  it("exposes registered plugin permissions dynamically via getPermissionsByRole", () => {
    const ownerPerms = getPermissionsByRole("owner");
    expect(ownerPerms).toContain("loyalty.read");
    expect(ownerPerms).toContain("loyalty.write");
    expect(ownerPerms).toContain("links.read");

    const memberPerms = getPermissionsByRole("member");
    expect(memberPerms).toContain("loyalty.read");
    expect(memberPerms).toContain("loyalty.write");

    const viewerPerms = getPermissionsByRole("viewer");
    expect(viewerPerms).toContain("loyalty.read");
    expect(viewerPerms).not.toContain("loyalty.write");

    const billingPerms = getPermissionsByRole("billing");
    expect(billingPerms).toContain("loyalty.read");
    expect(billingPerms).not.toContain("loyalty.write");
  });

  it("dynamically augments RESOURCE_KEYS and RESOURCES with registered plugins", () => {
    expect(RESOURCE_KEYS).toContain("loyalty");
    expect(RESOURCE_KEYS).toContain("links");

    const loyaltyResource = RESOURCES.find((r) => r.key === "loyalty");
    expect(loyaltyResource).toBeDefined();
    expect(loyaltyResource?.name).toBe("Loyalty");
  });

  it("dynamically augments SCOPES and resource scope mappings", () => {
    expect(SCOPES).toContain("loyalty.read");
    expect(SCOPES).toContain("loyalty.write");
    expect(SCOPES).toContain("links.read");

    // Scopes to permissions resolution
    const readPerms = mapScopesToPermissions(["loyalty.read"]);
    expect(readPerms).toContain("loyalty.read");

    const writePerms = mapScopesToPermissions(["loyalty.write"]);
    expect(writePerms).toContain("loyalty.write");
    expect(writePerms).toContain("loyalty.read");

    // apis.read expansion
    const apisReadPerms = mapScopesToPermissions(["apis.read"]);
    expect(apisReadPerms).toContain("loyalty.read");
    expect(apisReadPerms).not.toContain("loyalty.write");

    // apis.all expansion
    const apisAllPerms = mapScopesToPermissions(["apis.all"]);
    expect(apisAllPerms).toContain("loyalty.read");
    expect(apisAllPerms).toContain("loyalty.write");
  });

  it("enforces role validation for plugin scopes", () => {
    expect(validateScopesForRole(["loyalty.read"], "viewer")).toBe(true);
    expect(validateScopesForRole(["loyalty.write"], "viewer")).toBe(false);

    expect(validateScopesForRole(["loyalty.write"], "owner")).toBe(true);
    expect(validateScopesForRole(["loyalty.write"], "member")).toBe(true);

    const ownerScopes = getScopesForRole("owner");
    expect(ownerScopes).toContain("loyalty.read");
    expect(ownerScopes).toContain("loyalty.write");
  });

  it("supports runtime extension with custom plugins without code modification", () => {
    permissionRegistry.register([
      {
        action: "custom_plugin.read",
        description: "read custom plugin",
        roles: ["owner", "member"],
        resource: {
          key: "custom_plugin",
          name: "Custom Plugin",
          description: "Custom plugin description",
        },
        scope: {
          type: "read",
          resource: "custom_plugin",
          includeInApisRead: true,
          includeInApisAll: true,
        },
      },
    ]);

    expect(getPermissionsByRole("owner")).toContain("custom_plugin.read");
    expect(getPermissionsByRole("viewer")).not.toContain("custom_plugin.read");
    expect(RESOURCE_KEYS).toContain("custom_plugin");
    expect(SCOPES).toContain("custom_plugin.read");
    expect(mapScopesToPermissions(["apis.read"])).toContain(
      "custom_plugin.read",
    );
  });
});
