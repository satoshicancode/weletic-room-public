import { WorkspaceRole } from "@prisma/client";
import { PermissionAction } from "../rbac/permissions";
import { permissionRegistry } from "../rbac/plugin-registry";
import { ResourceKey } from "../rbac/resources";

export const DUB_SCOPES = [
  "links.read",
  "links.write",
  "tags.read",
  "tags.write",
  "folders.read",
  "folders.write",
  "analytics.read",
  "domains.read",
  "domains.write",
  "workspaces.read",
  "workspaces.write",
  "webhooks.read",
  "webhooks.write",
  "groups.read",
  "groups.write",
  "apis.all", // All API scopes
  "apis.read", // All read scopes
] as const;

export type DubScope = (typeof DUB_SCOPES)[number];
export type Scope = DubScope | (string & {});

// Scopes available for Workspace API keys
export const DUB_RESOURCE_SCOPES: {
  scope: Scope;
  roles: WorkspaceRole[];
  permissions: PermissionAction[];
  type?: "read" | "write";
  resource?: ResourceKey;
}[] = [
  {
    scope: "links.read",
    roles: ["owner", "member", "viewer", "billing"],
    permissions: ["links.read"],
    type: "read",
    resource: "links",
  },
  {
    scope: "links.write",
    roles: ["owner", "member"],
    permissions: ["links.write", "links.read"],
    type: "write",
    resource: "links",
  },
  {
    scope: "tags.read",
    roles: ["owner", "member", "viewer", "billing"],
    permissions: ["tags.read"],
    type: "read",
    resource: "tags",
  },
  {
    scope: "tags.write",
    roles: ["owner", "member"],
    permissions: ["tags.write", "tags.read"],
    type: "write",
    resource: "tags",
  },
  {
    scope: "folders.read",
    roles: ["owner", "member", "viewer", "billing"],
    permissions: ["folders.read"],
    type: "read",
    resource: "folders",
  },
  {
    scope: "folders.write",
    roles: ["owner", "member"],
    permissions: ["folders.write", "folders.read"],
    type: "write",
    resource: "folders",
  },
  {
    scope: "domains.read",
    roles: ["owner", "member", "viewer", "billing"],
    permissions: ["domains.read"],
    type: "read",
    resource: "domains",
  },
  {
    scope: "domains.write",
    roles: ["owner"],
    permissions: ["domains.write", "domains.read"],
    type: "write",
    resource: "domains",
  },
  {
    scope: "groups.read",
    roles: ["owner", "member", "viewer", "billing"],
    permissions: ["groups.read"],
    type: "read",
    resource: "groups",
  },
  {
    scope: "groups.write",
    roles: ["owner", "member"],
    permissions: ["groups.write", "groups.read"],
    type: "write",
    resource: "groups",
  },
  {
    scope: "workspaces.read",
    roles: ["owner", "member", "viewer", "billing"],
    permissions: ["workspaces.read"],
    type: "read",
    resource: "workspaces",
  },
  {
    scope: "workspaces.write",
    roles: ["owner"],
    permissions: ["workspaces.write", "workspaces.read"],
    type: "write",
    resource: "workspaces",
  },
  {
    scope: "analytics.read",
    roles: ["owner", "member", "viewer", "billing"],
    permissions: ["analytics.read"],
    type: "read",
    resource: "analytics",
  },
  {
    scope: "webhooks.read",
    roles: ["owner", "member", "viewer", "billing"],
    permissions: ["webhooks.read"],
    type: "read",
    resource: "webhooks",
  },
  {
    scope: "webhooks.write",
    roles: ["owner"],
    permissions: ["webhooks.write", "webhooks.read"],
    type: "write",
    resource: "webhooks",
  },
  {
    scope: "apis.read",
    roles: ["owner", "member", "viewer", "billing"],
    permissions: [
      "links.read",
      "tags.read",
      "folders.read",
      "domains.read",
      "workspaces.read",
      "analytics.read",
      "groups.read",
    ],
  },
  {
    scope: "apis.all",
    roles: ["owner", "member"],
    permissions: [
      "links.read",
      "links.write",
      "tags.read",
      "tags.write",
      "folders.read",
      "folders.write",
      "domains.read",
      "domains.write",
      "workspaces.read",
      "workspaces.write",
      "analytics.read",
      "groups.read",
      "groups.write",
    ],
  },
];

function getCombinedScopes(): string[] {
  const pluginScopes = permissionRegistry.getRegisteredScopes();
  const baseScopes = DUB_SCOPES.filter(
    (s) => s !== "apis.all" && s !== "apis.read",
  );
  return [...baseScopes, ...pluginScopes, "apis.all", "apis.read"];
}

export const SCOPES = new Proxy([] as unknown as readonly Scope[], {
  get(_target, prop, receiver) {
    const combined = getCombinedScopes();
    if (prop === "length") return combined.length;
    if (prop === Symbol.iterator)
      return combined[Symbol.iterator].bind(combined);
    if (typeof prop === "string" && !isNaN(Number(prop)))
      return combined[Number(prop)];
    const val = (combined as any)[prop];
    if (typeof val === "function") return val.bind(combined);
    return Reflect.get(combined, prop, receiver);
  },
}) as readonly Scope[];

function getCombinedResourceScopes(): typeof DUB_RESOURCE_SCOPES {
  const pluginScopes = permissionRegistry.getRegisteredResourceScopes();
  return [...DUB_RESOURCE_SCOPES, ...pluginScopes];
}

export const RESOURCE_SCOPES = new Proxy(
  [] as unknown as typeof DUB_RESOURCE_SCOPES,
  {
    get(_target, prop, receiver) {
      const combined = getCombinedResourceScopes();
      if (prop === "length") return combined.length;
      if (prop === Symbol.iterator)
        return combined[Symbol.iterator].bind(combined);
      if (typeof prop === "string" && !isNaN(Number(prop)))
        return combined[Number(prop)];
      const val = (combined as any)[prop];
      if (typeof val === "function") return val.bind(combined);
      return Reflect.get(combined, prop, receiver);
    },
  },
) as typeof DUB_RESOURCE_SCOPES;

export const SCOPES_BY_RESOURCE = new Proxy({} as Record<string, any>, {
  get(_target, prop) {
    const current = getCombinedResourceScopes().reduce((acc, scope) => {
      if (!scope.resource || !scope.type) {
        return acc;
      }
      if (!acc[scope.resource]) {
        acc[scope.resource] = [];
      }
      acc[scope.resource].push({
        scope: scope.scope,
        type: scope.type,
        roles: scope.roles,
      });
      return acc;
    }, {});
    return (current as any)[prop];
  },
});

export const SCOPE_PERMISSIONS_MAP = new Proxy({} as Record<string, any>, {
  get(_target, prop) {
    const current = getCombinedResourceScopes().reduce((acc, scope) => {
      acc[scope.scope] = scope.permissions;
      return acc;
    }, {});
    return (current as any)[prop];
  },
});

export const ROLE_SCOPES_MAP = new Proxy({} as Record<string, any>, {
  get(_target, prop) {
    const current = getCombinedResourceScopes().reduce((acc, scope) => {
      scope.roles.forEach((role) => {
        if (!acc[role]) {
          acc[role] = [];
        }
        acc[role].push(scope.scope);
      });
      return acc;
    }, {});
    return (current as any)[prop];
  },
});

// For each scope, get the permissions it grants access to and return array of permissions
export const mapScopesToPermissions = (scopes: Scope[]) => {
  const permissions: PermissionAction[] = [];
  const currentResourceScopes = getCombinedResourceScopes();
  const currentScopePermissionsMap = currentResourceScopes.reduce(
    (acc, scope) => {
      acc[scope.scope] = scope.permissions;
      return acc;
    },
    {},
  );

  scopes.forEach((scope) => {
    if (currentScopePermissionsMap[scope]) {
      permissions.push(...currentScopePermissionsMap[scope]);
    }
    const extra = permissionRegistry.mapPluginScopesToPermissions(scope);
    permissions.push(...extra);
  });

  return [...new Set(permissions)];
};

// Get SCOPES_BY_RESOURCE based on user role in a workspace
export const getScopesByResourceForRole = (role: WorkspaceRole) => {
  const groupedByResource = {};

  const allowedScopes = getCombinedResourceScopes()
    .map((scope) => {
      if (scope.roles.includes(role)) {
        return scope;
      }
    })
    .filter(Boolean);

  allowedScopes.forEach((scope) => {
    if (scope && scope.resource) {
      if (!groupedByResource[scope.resource]) {
        groupedByResource[scope.resource] = [];
      }

      groupedByResource[scope.resource].push(scope);
    }
  });

  return groupedByResource;
};

export const scopePresets = [
  {
    value: "all_access",
    label: "All",
    description: "full access to all resources",
  },
  {
    value: "read_only",
    label: "Read Only",
    description: "read-only access to all resources",
  },
  {
    value: "restricted",
    label: "Restricted",
    description: "restricted access to some resources",
  },
];

export const scopesToName = (scopes: string[]) => {
  if (scopes.includes("apis.all")) {
    return {
      name: "All access",
      description: "full access to all resources",
    };
  }

  if (scopes.includes("apis.read")) {
    return {
      name: "Read-only",
      description: "read-only access to all resources",
    };
  }

  return {
    name: "Restricted",
    description: "restricted access to some resources",
  };
};

export const validateScopesForRole = (scopes: Scope[], role: WorkspaceRole) => {
  const currentResourceScopes = getCombinedResourceScopes();
  const currentRoleScopesMap = currentResourceScopes.reduce((acc, scope) => {
    scope.roles.forEach((r) => {
      if (!acc[r]) {
        acc[r] = [];
      }
      acc[r].push(scope.scope);
    });
    return acc;
  }, {});
  const allowedScopes = currentRoleScopesMap[role] || [];
  const invalidScopes = scopes.filter(
    (scope) => !allowedScopes.includes(scope),
  );

  return !(invalidScopes.length > 0);
};

// Get the scopes for a role
export const getScopesForRole = (role: WorkspaceRole) => {
  const currentResourceScopes = getCombinedResourceScopes();
  const currentRoleScopesMap = currentResourceScopes.reduce((acc, scope) => {
    scope.roles.forEach((r) => {
      if (!acc[r]) {
        acc[r] = [];
      }
      acc[r].push(scope.scope);
    });
    return acc;
  }, {});
  return currentRoleScopesMap[role] || [];
};

// Consolidate scopes to avoid duplication and show only the most permissive scope
export const consolidateScopes = (scopes: string[]) => {
  const consolidated = new Set();

  scopes.forEach((scope) => {
    const [resource, action] = scope.split(".");

    if (action === "write") {
      consolidated.add(`${resource}.write`);
    } else if (action === "read" && !consolidated.has(`${resource}.write`)) {
      consolidated.add(`${resource}.read`);
    }
  });

  return Array.from(consolidated) as string[];
};
