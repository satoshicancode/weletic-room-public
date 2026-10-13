import { redis } from "./redis";

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

/**
 * Runs `fn` while holding a Redis NX lock. Returns `null` if the lock
 * could not be acquired (another holder is active).
 * Stores a unique token and releases via compare-and-delete so an expired
 * lock acquired by another runner is never deleted by this run.
 * Automatically renews the lock TTL via a background heartbeat timer to prevent
 * premature expiration during long-running tasks (PERF-07).
 */
export async function withRedisLock<T>({
  key,
  ttlSeconds,
  fn,
}: {
  key: string;
  ttlSeconds: number;
  fn: () => Promise<T>;
}): Promise<T | null> {
  const token = crypto.randomUUID();
  const acquired = await redis.set(key, token, {
    nx: true,
    ex: ttlSeconds,
  });

  if (!acquired) {
    return null;
  }

  let renewalInFlight = false;
  const renewalIntervalMs = Math.max(
    1_000,
    Math.floor((ttlSeconds * 1_000) / 3),
  );
  const renewalTimer = setInterval(() => {
    if (renewalInFlight) return;
    renewalInFlight = true;
    void redis
      .eval(RENEW_LOCK_SCRIPT, [key], [token, String(ttlSeconds)])
      .catch(() => {})
      .finally(() => {
        renewalInFlight = false;
      });
  }, renewalIntervalMs);
  renewalTimer.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(renewalTimer);
    // Lua compare-and-delete: only the token owner may release the lock.
    await redis.eval(RELEASE_LOCK_SCRIPT, [key], [token]);
  }
}
