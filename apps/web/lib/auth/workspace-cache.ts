import { WorkspaceWithUsers } from "@/lib/types";
import { LRUCache } from "lru-cache";
import { normalizeWorkspaceId } from "../api/workspaces/workspace-id";

export const WORKSPACE_AUTH_CACHE_TTL = 1000 * 30; // 30 seconds
export const WORKSPACE_AUTH_CACHE_MAX = 5000; // max 5,000 entries
const CACHE_KEY_PREFIX = "workspaceAuth";

/**
 * Thread-safe, in-memory LRU micro-cache for workspace authorization resolution.
 * Prevents redundant database queries when concurrent/parallel requests
 * are executed for the same workspace and user session.
 */
class WorkspaceAuthCache {
  private cache: LRUCache<string, WorkspaceWithUsers>;

  constructor({
    max = WORKSPACE_AUTH_CACHE_MAX,
    ttl = WORKSPACE_AUTH_CACHE_TTL,
  }: {
    max?: number;
    ttl?: number;
  } = {}) {
    this.cache = new LRUCache<string, WorkspaceWithUsers>({
      max,
      ttl,
      allowStale: false,
      updateAgeOnGet: false, // Ensure strict 30s upper bound on cached permissions
    });
  }

  /**
   * Helper to format a cache key
   */
  private createKey(identifier: string, userId: string): string {
    return `${CACHE_KEY_PREFIX}:${identifier}:${userId}`;
  }

  /**
   * Get cached workspace auth resolution for a given workspace identifier (id or slug) and user.
   */
  public get({
    identifier,
    userId,
  }: {
    identifier: string;
    userId: string;
  }): WorkspaceWithUsers | null {
    if (!identifier || !userId) {
      return null;
    }

    // Try direct lookup
    let cached = this.cache.get(this.createKey(identifier, userId));

    // If not found and identifier starts with ws_, try normalized ID
    if (!cached && identifier.startsWith("ws_")) {
      const normalized = normalizeWorkspaceId(identifier);
      cached = this.cache.get(this.createKey(normalized, userId));
    }

    if (!cached) {
      return null;
    }

    // Return a shallow clone of workspace and users to prevent accidental in-memory object mutation
    return {
      ...cached,
      users: cached.users ? cached.users.map((user) => ({ ...user })) : [],
    };
  }

  /**
   * Cache a resolved workspace auth object under its ID, slug, and any custom identifier used.
   */
  public set({
    workspace,
    userId,
    identifier,
  }: {
    workspace: WorkspaceWithUsers;
    userId: string;
    identifier?: string;
  }): void {
    if (!workspace || !userId) {
      return;
    }

    // Store cloned object to guarantee cache immutability
    const clone: WorkspaceWithUsers = {
      ...workspace,
      users: workspace.users
        ? workspace.users.map((user) => ({ ...user }))
        : [],
    };

    // Cache by workspace.id
    if (workspace.id) {
      this.cache.set(this.createKey(workspace.id, userId), clone);
      this.cache.set(
        this.createKey(normalizeWorkspaceId(workspace.id), userId),
        clone,
      );
    }

    // Cache by workspace.slug
    if (workspace.slug) {
      this.cache.set(this.createKey(workspace.slug, userId), clone);
    }

    // Cache by the specific identifier requested if different
    if (
      identifier &&
      identifier !== workspace.id &&
      identifier !== workspace.slug
    ) {
      this.cache.set(this.createKey(identifier, userId), clone);
    }
  }

  /**
   * Invalidate cache for a specific user in a workspace.
   */
  public delete({
    workspaceId,
    workspaceSlug,
    userId,
  }: {
    workspaceId?: string;
    workspaceSlug?: string;
    userId?: string;
  }): void {
    if (!userId) {
      this.deleteByWorkspace({ workspaceId, workspaceSlug });
      return;
    }

    if (workspaceId) {
      this.cache.delete(this.createKey(workspaceId, userId));
      this.cache.delete(
        this.createKey(normalizeWorkspaceId(workspaceId), userId),
      );
      const rawId = workspaceId.replace(/^ws_/, "");
      this.cache.delete(this.createKey(`ws_${rawId}`, userId));
      this.cache.delete(this.createKey(rawId, userId));
    }

    if (workspaceSlug) {
      this.cache.delete(this.createKey(workspaceSlug, userId));
    }
  }

  /**
   * Invalidate all cached resolutions for a workspace across all users.
   */
  public deleteByWorkspace({
    workspaceId,
    workspaceSlug,
  }: {
    workspaceId?: string;
    workspaceSlug?: string;
  }): void {
    const prefixes: string[] = [];

    if (workspaceId) {
      const rawId = workspaceId.replace(/^ws_/, "");
      prefixes.push(
        `${CACHE_KEY_PREFIX}:${workspaceId}:`,
        `${CACHE_KEY_PREFIX}:${normalizeWorkspaceId(workspaceId)}:`,
        `${CACHE_KEY_PREFIX}:ws_${rawId}:`,
        `${CACHE_KEY_PREFIX}:${rawId}:`,
      );
    }

    if (workspaceSlug) {
      prefixes.push(`${CACHE_KEY_PREFIX}:${workspaceSlug}:`);
    }

    if (prefixes.length === 0) {
      return;
    }

    for (const key of this.cache.keys()) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Invalidate all cached resolutions for a given user across all workspaces.
   */
  public deleteByUser({ userId }: { userId: string }): void {
    if (!userId) return;
    const suffix = `:${userId}`;
    for (const key of this.cache.keys()) {
      if (key.endsWith(suffix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear the entire cache.
   */
  public clear(): void {
    this.cache.clear();
  }

  /**
   * Get the current size of the cache (for metrics / testing).
   */
  public get size(): number {
    return this.cache.size;
  }
}

export const workspaceAuthCache = new WorkspaceAuthCache();
