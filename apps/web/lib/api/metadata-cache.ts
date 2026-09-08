import { redisGlobal, redisGlobalWithTimeout } from "@/lib/upstash";
import { LRUCache } from "lru-cache";

const LRU_MAX_ITEMS = 5000;
const LRU_TTL_MS = 5 * 60 * 1000; // 5 minutes in milliseconds
const REDIS_TTL_SEC = 5 * 60; // 5 minutes in seconds
const VERSION_TTL_SEC = 24 * 60 * 60;

interface VersionedCacheValue<T> {
  __metadataCacheVersion: string;
  data: T;
}

type VersionScope = string | string[];

export class MetadataCache {
  private lru: LRUCache<string, {}>;

  constructor() {
    this.lru = new LRUCache<string, {}>({
      max: LRU_MAX_ITEMS,
      ttl: LRU_TTL_MS,
    });
  }

  // ---------------------------------------------------------------------------
  // Internal Safe Redis Helpers (Non-blocking & Fault-Tolerant)
  // ---------------------------------------------------------------------------

  private async _redisGet<T>(key: string): Promise<T | null> {
    if (
      !process.env.UPSTASH_REDIS_REST_URL &&
      !process.env.UPSTASH_GLOBAL_REDIS_REST_URL
    ) {
      return null;
    }
    try {
      const data = await redisGlobalWithTimeout.get<T>(key);
      return data ?? null;
    } catch {
      return null;
    }
  }

  private async _redisSet(
    key: string,
    value: unknown,
    ttlSec = REDIS_TTL_SEC,
  ): Promise<void> {
    if (
      !process.env.UPSTASH_REDIS_REST_URL &&
      !process.env.UPSTASH_GLOBAL_REDIS_REST_URL
    ) {
      return;
    }
    try {
      await redisGlobal.set(key, value, { ex: ttlSec });
    } catch {
      // Graceful degradation: in-memory LRU handles the cache
    }
  }

  private async _redisDel(keys: string[]): Promise<void> {
    if (
      !keys.length ||
      (!process.env.UPSTASH_REDIS_REST_URL &&
        !process.env.UPSTASH_GLOBAL_REDIS_REST_URL)
    ) {
      return;
    }
    try {
      if (keys.length === 1) {
        await redisGlobal.del(keys[0]);
      } else {
        const pipeline = redisGlobal.pipeline();
        keys.forEach((k) => pipeline.del(k));
        await pipeline.exec();
      }
    } catch {
      // Graceful degradation
    }
  }

  private _versionKey(scope: string): string {
    return `meta:version:${scope}`;
  }

  private async _version(scope: VersionScope): Promise<string> {
    const scopes = Array.isArray(scope) ? scope : [scope];
    const versions = await Promise.all(
      scopes.map(
        async (item) =>
          (await this._redisGet<string>(this._versionKey(item))) ?? "0",
      ),
    );
    return versions.join("|");
  }

  private async _bumpVersion(scope: string): Promise<void> {
    await this._redisSet(
      this._versionKey(scope),
      `${Date.now()}:${Math.random().toString(36).slice(2)}`,
      VERSION_TTL_SEC,
    );
  }

  private _unwrap<T>(
    value: unknown,
    version: string,
  ): { found: boolean; data: T | null } {
    if (
      value &&
      typeof value === "object" &&
      "__metadataCacheVersion" in value &&
      "data" in value
    ) {
      const envelope = value as VersionedCacheValue<T>;
      return envelope.__metadataCacheVersion === version
        ? { found: true, data: envelope.data }
        : { found: false, data: null };
    }
    return version === "0" && value !== undefined && value !== null
      ? { found: true, data: value as T }
      : { found: false, data: null };
  }

  private async _getVersioned<T>(
    key: string,
    scope: VersionScope,
  ): Promise<T | null> {
    const version = await this._version(scope);
    const memoryValue = this._unwrap<T>(this.lru.get(key), version);
    if (memoryValue.found) return memoryValue.data;
    this.lru.delete(key);

    const redisValue = await this._redisGet<unknown>(key);
    const remoteValue = this._unwrap<T>(redisValue, version);
    if (!remoteValue.found) return null;
    this.lru.set(key, redisValue as {});
    return remoteValue.data;
  }

  private async _setVersioned<T>(
    key: string,
    scope: VersionScope,
    data: T,
  ): Promise<void> {
    const envelope: VersionedCacheValue<T> = {
      __metadataCacheVersion: await this._version(scope),
      data,
    };
    this.lru.set(key, envelope);
    await this._redisSet(key, envelope);
  }

  // ---------------------------------------------------------------------------
  // Program Metadata Caching
  // ---------------------------------------------------------------------------

  private _programKey(
    workspaceId: string,
    programId: string,
    includeKey = "default",
  ): string {
    return `meta:program:${workspaceId}:${programId}:${includeKey}`;
  }

  async getProgram<T>(
    workspaceId: string,
    programId: string,
    includeKey = "default",
  ): Promise<T | null> {
    const key = this._programKey(workspaceId, programId, includeKey);
    return this._getVersioned<T>(key, `program:${programId}`);
  }

  async setProgram<T>(
    workspaceId: string,
    programId: string,
    data: T,
    includeKey = "default",
  ): Promise<void> {
    const key = this._programKey(workspaceId, programId, includeKey);
    await this._setVersioned(key, `program:${programId}`, data);
  }

  async invalidateProgram(
    programId: string,
    workspaceId?: string,
  ): Promise<void> {
    await this._bumpVersion(`program:${programId}`);
    const prefix = workspaceId
      ? `meta:program:${workspaceId}:${programId}:`
      : `meta:program:`;

    const keysToDelete: string[] = [];
    for (const key of Array.from(this.lru.keys())) {
      if (
        workspaceId ? key.startsWith(prefix) : key.includes(`:${programId}:`)
      ) {
        this.lru.delete(key);
        keysToDelete.push(key);
      }
    }

    if (keysToDelete.length > 0) {
      await this._redisDel(keysToDelete);
    }
  }

  // ---------------------------------------------------------------------------
  // Partner Group Metadata Caching (Dual-Indexed by ID & Slug)
  // ---------------------------------------------------------------------------

  private _groupKey(
    programId: string,
    groupIdOrSlug: string,
    optionsKey = "default",
  ): string {
    return `meta:group:${programId}:${groupIdOrSlug}:${optionsKey}`;
  }

  async getGroup<T>(
    programId: string,
    groupIdOrSlug: string,
    optionsKey = "default",
  ): Promise<T | null> {
    const key = this._groupKey(programId, groupIdOrSlug, optionsKey);
    return this._getVersioned<T>(key, [
      `group-all:${programId}`,
      `group:${programId}:${groupIdOrSlug}`,
    ]);
  }

  async setGroup<T>(
    programId: string,
    groupIdOrSlug: string,
    data: T,
    optionsKey = "default",
    resolvedId?: string,
    resolvedSlug?: string,
  ): Promise<void> {
    const identifiers = [groupIdOrSlug, resolvedId, resolvedSlug].filter(
      (identifier, index, values): identifier is string =>
        Boolean(identifier) && values.indexOf(identifier) === index,
    );

    await Promise.all(
      identifiers.map((identifier) =>
        this._setVersioned(
          this._groupKey(programId, identifier, optionsKey),
          [`group-all:${programId}`, `group:${programId}:${identifier}`],
          data,
        ),
      ),
    );
  }

  async invalidateGroup(
    programId: string,
    groupId?: string,
    ...slugs: (string | undefined | null)[]
  ): Promise<void> {
    const targets = [groupId, ...slugs].filter(Boolean) as string[];
    if (targets.length === 0) {
      await this._bumpVersion(`group-all:${programId}`);
    } else {
      await Promise.all(
        targets.map((target) =>
          this._bumpVersion(`group:${programId}:${target}`),
        ),
      );
    }
    const keysToDeleteSet = new Set<string>();

    for (const key of Array.from(this.lru.keys())) {
      if (
        targets.length === 0
          ? key.startsWith(`meta:group:${programId}:`)
          : targets.some((t) => key.startsWith(`meta:group:${programId}:${t}:`))
      ) {
        this.lru.delete(key);
        keysToDeleteSet.add(key);
      }
    }

    const standardOptionsKeys = ["default", "0:0", "1:0", "0:1", "1:1"];
    for (const target of targets) {
      for (const opt of standardOptionsKeys) {
        const k = `meta:group:${programId}:${target}:${opt}`;
        this.lru.delete(k);
        keysToDeleteSet.add(k);
      }
    }

    if (keysToDeleteSet.size > 0) {
      await this._redisDel(Array.from(keysToDeleteSet));
    }
  }

  async invalidateAllGroups(programId: string): Promise<void> {
    await this.invalidateGroup(programId);
  }

  // ---------------------------------------------------------------------------
  // Reward Metadata Caching
  // ---------------------------------------------------------------------------

  private _rewardKey(programId: string, rewardId: string): string {
    return `meta:reward:${programId}:${rewardId}`;
  }

  private _programRewardsKey(programId: string): string {
    return `meta:rewards:${programId}`;
  }

  async getReward<T>(programId: string, rewardId: string): Promise<T | null> {
    const key = this._rewardKey(programId, rewardId);
    return this._getVersioned<T>(key, [
      `reward-all:${programId}`,
      `reward:${programId}:${rewardId}`,
    ]);
  }

  async setReward<T>(
    programId: string,
    rewardId: string,
    data: T,
  ): Promise<void> {
    const key = this._rewardKey(programId, rewardId);
    await this._setVersioned(
      key,
      [`reward-all:${programId}`, `reward:${programId}:${rewardId}`],
      data,
    );
  }

  async getProgramRewards<T>(programId: string): Promise<T | null> {
    const key = this._programRewardsKey(programId);
    return this._getVersioned<T>(key, `rewards:${programId}`);
  }

  async setProgramRewards<T>(programId: string, data: T): Promise<void> {
    const key = this._programRewardsKey(programId);
    await this._setVersioned(key, `rewards:${programId}`, data);
  }

  async invalidateReward(programId: string, rewardId?: string): Promise<void> {
    await this._bumpVersion(`rewards:${programId}`);
    await this._bumpVersion(
      rewardId ? `reward:${programId}:${rewardId}` : `reward-all:${programId}`,
    );
    const keysToDelete: string[] = [this._programRewardsKey(programId)];

    if (rewardId) {
      keysToDelete.push(this._rewardKey(programId, rewardId));
      this.lru.delete(this._rewardKey(programId, rewardId));
    } else {
      for (const key of Array.from(this.lru.keys())) {
        if (key.startsWith(`meta:reward:${programId}:`)) {
          this.lru.delete(key);
          keysToDelete.push(key);
        }
      }
    }

    this.lru.delete(this._programRewardsKey(programId));
    await this._redisDel(keysToDelete);
  }

  // ---------------------------------------------------------------------------
  // Cache Reset (Testing / Diagnostics)
  // ---------------------------------------------------------------------------
  clear(): void {
    this.lru.clear();
  }
}

export const metadataCache = new MetadataCache();
