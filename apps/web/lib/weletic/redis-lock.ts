import { redis } from "@/lib/upstash";
import { nanoid } from "@dub/utils";

const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

const RENEW_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], ARGV[2])
else
  return 0
end
`;

interface InMemoryLockRecord {
  token: string;
  expiresAt: number;
}

const inMemoryLocks = new Map<string, InMemoryLockRecord>();

function cleanExpiredInMemoryLocks(now = Date.now()) {
  for (const [k, lock] of inMemoryLocks.entries()) {
    if (lock.expiresAt <= now) {
      inMemoryLocks.delete(k);
    }
  }
}

export function resetInMemoryLocks() {
  inMemoryLocks.clear();
}

export async function acquireDistributedLock({
  key,
  ttlSeconds = 60,
}: {
  key: string;
  ttlSeconds?: number;
}): Promise<{ acquired: boolean; token: string }> {
  const token = nanoid();
  try {
    const result = await redis.set(key, token, {
      nx: true,
      ex: ttlSeconds,
    });
    return { acquired: Boolean(result), token };
  } catch (error) {
    if (!process.env.UPSTASH_REDIS_REST_URL?.includes("upstash.invalid")) {
      console.error(`[DistributedLock] Failed to acquire lock for ${key}`, error);
    }
    const now = Date.now();
    cleanExpiredInMemoryLocks(now);
    const existing = inMemoryLocks.get(key);
    if (existing && existing.expiresAt > now) {
      return { acquired: false, token };
    }
    inMemoryLocks.set(key, { token, expiresAt: now + ttlSeconds * 1000 });
    return { acquired: true, token };
  }
}

export async function releaseDistributedLock({
  key,
  token,
}: {
  key: string;
  token: string;
}): Promise<boolean> {
  try {
    const result = await redis.eval(RELEASE_LOCK_SCRIPT, [key], [token]);
    const memoryLock = inMemoryLocks.get(key);
    if (memoryLock && memoryLock.token === token) {
      inMemoryLocks.delete(key);
    }
    return Number(result) === 1;
  } catch (error) {
    if (!process.env.UPSTASH_REDIS_REST_URL?.includes("upstash.invalid")) {
      console.error(`[DistributedLock] Failed to release lock for ${key}`, error);
    }
    const memoryLock = inMemoryLocks.get(key);
    if (memoryLock && memoryLock.token === token) {
      inMemoryLocks.delete(key);
      return true;
    }
    return false;
  }
}

export async function renewDistributedLock({
  key,
  token,
  ttlSeconds,
}: {
  key: string;
  token: string;
  ttlSeconds: number;
}): Promise<boolean> {
  try {
    const result = await redis.eval(
      RENEW_LOCK_SCRIPT,
      [key],
      [token, String(ttlSeconds)],
    );
    const memoryLock = inMemoryLocks.get(key);
    if (memoryLock && memoryLock.token === token) {
      memoryLock.expiresAt = Date.now() + ttlSeconds * 1000;
    }
    return Number(result) === 1;
  } catch (error) {
    if (!process.env.UPSTASH_REDIS_REST_URL?.includes("upstash.invalid")) {
      console.error(`[DistributedLock] Failed to renew lock for ${key}`, error);
    }
    const now = Date.now();
    const memoryLock = inMemoryLocks.get(key);
    if (memoryLock && memoryLock.token === token && memoryLock.expiresAt > now) {
      memoryLock.expiresAt = now + ttlSeconds * 1000;
      return true;
    }
    return false;
  }
}

export async function withDistributedLock<T>({
  key,
  ttlSeconds = 60,
  onLocked,
  fn,
}: {
  key: string;
  ttlSeconds?: number;
  onLocked?: () => T | Promise<T>;
  fn: () => Promise<T>;
}): Promise<T> {
  const { acquired, token } = await acquireDistributedLock({ key, ttlSeconds });
  if (!acquired) {
    if (onLocked) return await onLocked();
    throw new Error(`Could not acquire lock for ${key}`);
  }
  let renewalInFlight = false;
  const renewalTimer = setInterval(
    () => {
      if (renewalInFlight) return;
      renewalInFlight = true;
      void renewDistributedLock({ key, token, ttlSeconds }).finally(() => {
        renewalInFlight = false;
      });
    },
    Math.max(1_000, Math.floor((ttlSeconds * 1_000) / 3)),
  );
  renewalTimer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(renewalTimer);
    await releaseDistributedLock({ key, token });
  }
}
