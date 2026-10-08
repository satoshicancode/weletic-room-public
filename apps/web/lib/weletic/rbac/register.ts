import { permissionRegistry } from "@/lib/api/rbac/plugin-registry";

let registered = false;

export function registerWeleticPermissions() {
  if (registered) return;
  registered = true;

  permissionRegistry.register([
    {
      action: "loyalty.read",
      description: "access loyalty program",
      roles: ["owner", "member", "viewer", "billing"],
      resource: {
        name: "Loyalty",
        key: "loyalty",
        description:
          "Create, read, update, and delete loyalty programs, rewards, and rules",
      },
      scope: {
        type: "read",
        resource: "loyalty",
        includeInApisRead: true,
        includeInApisAll: true,
      },
    },
    {
      action: "loyalty.write",
      description: "manage loyalty program",
      roles: ["owner", "member"],
      resource: {
        name: "Loyalty",
        key: "loyalty",
        description:
          "Create, read, update, and delete loyalty programs, rewards, and rules",
      },
      scope: {
        type: "write",
        resource: "loyalty",
        includeInApisAll: true,
      },
    },
  ]);
}

// Auto-register upon import
registerWeleticPermissions();
