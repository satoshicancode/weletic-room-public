import { WorkspaceRole } from "@prisma/client";

export type ExtendedPermissionAction = string;

export interface PluginPermissionDefinition {
  action: string;
  description: string;
  roles: WorkspaceRole[];
  resource?: {
    key: string;
    name: string;
    description: string;
  };
  scope?: {
    type: "read" | "write";
    resource: string;
    includeInApisRead?: boolean;
    includeInApisAll?: boolean;
  };
}

class PermissionPluginRegistry {
  private registeredPermissions = new Map<string, PluginPermissionDefinition>();

  public register(definitions: PluginPermissionDefinition[]) {
    for (const def of definitions) {
      this.registeredPermissions.set(def.action, def);
    }
  }

  public getPermissionsByRole(role: WorkspaceRole): string[] {
    return Array.from(this.registeredPermissions.values())
      .filter((def) => def.roles.includes(role))
      .map((def) => def.action);
  }

  public getRegisteredActions(): string[] {
    return Array.from(this.registeredPermissions.keys());
  }

  public mapPluginScopesToPermissions(scope: string): string[] {
    const permissions: string[] = [];
    for (const def of this.registeredPermissions.values()) {
      if (def.action === scope) {
        permissions.push(def.action);
        // If write permission, automatically grant corresponding read permission
        if (def.scope?.type === "write") {
          const readAction = def.action.replace(/\.write$/, ".read");
          if (this.registeredPermissions.has(readAction)) {
            permissions.push(readAction);
          }
        }
      }
      if (scope === "apis.read" && def.scope?.includeInApisRead) {
        permissions.push(def.action);
      }
      if (scope === "apis.all" && def.scope?.includeInApisAll) {
        permissions.push(def.action);
      }
    }
    return permissions;
  }

  public getRegisteredResourceKeys(): string[] {
    const keys = new Set<string>();
    for (const def of this.registeredPermissions.values()) {
      if (def.resource?.key) {
        keys.add(def.resource.key);
      } else if (def.scope?.resource) {
        keys.add(def.scope.resource);
      }
    }
    return Array.from(keys);
  }

  public getRegisteredResources(): Array<{
    name: string;
    key: string;
    description: string;
  }> {
    const resources = new Map<
      string,
      { name: string; key: string; description: string }
    >();
    for (const def of this.registeredPermissions.values()) {
      if (def.resource) {
        resources.set(def.resource.key, def.resource);
      } else if (def.scope?.resource) {
        const key = def.scope.resource;
        const name = key.charAt(0).toUpperCase() + key.slice(1);
        resources.set(key, {
          name,
          key,
          description: `Create, read, update, and delete ${key}`,
        });
      }
    }
    return Array.from(resources.values());
  }

  public getRegisteredScopes(): string[] {
    const scopes: string[] = [];
    for (const def of this.registeredPermissions.values()) {
      if (def.scope) {
        scopes.push(def.action);
      }
    }
    return scopes;
  }

  public getRegisteredResourceScopes(): any[] {
    const list: any[] = [];
    for (const def of this.registeredPermissions.values()) {
      if (def.scope) {
        const perms = [def.action];
        if (def.scope.type === "write") {
          const readAction = def.action.replace(/\.write$/, ".read");
          if (this.registeredPermissions.has(readAction)) {
            perms.push(readAction);
          }
        }
        list.push({
          scope: def.action,
          roles: def.roles,
          permissions: perms,
          type: def.scope.type,
          resource: def.scope.resource,
        });
      }
    }
    return list;
  }

  public getRegisteredRolePermissions(): Array<{
    action: string;
    description: string;
    roles: WorkspaceRole[];
  }> {
    return Array.from(this.registeredPermissions.values()).map((def) => ({
      action: def.action,
      description: def.description,
      roles: def.roles,
    }));
  }

  public clear(): void {
    this.registeredPermissions.clear();
  }
}

export const permissionRegistry = new PermissionPluginRegistry();
