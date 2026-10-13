import dnsCallback, { promises as dns } from "dns";
import { isIP } from "net";

export const pinnedDnsMap: Map<string, string> = ((
  globalThis as any
).__pinnedDnsMap ??= new Map<string, string>());

export function installDnsPinHook() {
  if ((globalThis as any).__dnsHookInstalled) return;
  (globalThis as any).__dnsHookInstalled = true;
  const originalLookup = dnsCallback.lookup;

  // @ts-expect-error - node internal signature matching
  dnsCallback.lookup = function (
    hostname: string,
    options: any,
    callback: any,
  ) {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "object" ? options : {};
    const lower = (hostname || "").toLowerCase();

    if (pinnedDnsMap.has(lower)) {
      const pinnedIp = pinnedDnsMap.get(lower)!;
      if (opts?.all) {
        return cb(null, [
          { address: pinnedIp, family: pinnedIp.includes(":") ? 6 : 4 },
        ]);
      }
      return cb(null, pinnedIp, pinnedIp.includes(":") ? 6 : 4);
    }

    const wrappedCb = (err: any, address: any, family: any) => {
      if (err) return cb(err);
      try {
        if (Array.isArray(address)) {
          for (const item of address) {
            assertSafeIp(item.address);
          }
        } else if (address) {
          assertSafeIp(address);
        }
        cb(null, address, family);
      } catch (validationErr) {
        cb(validationErr);
      }
    };

    if (typeof options === "function") {
      return originalLookup.call(dnsCallback, hostname, wrappedCb);
    }
    return originalLookup.call(dnsCallback, hostname, options, wrappedCb);
  };
}

export function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // fail-closed on malformed IPv4
  }
  return (
    parts[0] === 127 || // loopback 127.0.0.0/8
    parts[0] === 10 || // private 10.0.0.0/8
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || // private 172.16.0.0/12
    (parts[0] === 192 && parts[1] === 168) || // private 192.168.0.0/16
    (parts[0] === 169 && parts[1] === 254) || // link-local 169.254.0.0/16 (includes 169.254.169.254)
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || // CGNAT 100.64.0.0/10
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) || // Benchmark 198.18.0.0/15
    parts[0] >= 224 || // multicast 224.0.0.0/4 and reserved 240.0.0.0/4
    parts[0] === 0 // unspecified 0.0.0.0/8
  );
}

export function parseIpv6Hextets(address: string): number[] | null {
  let clean = address
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();

  // Handle embedded IPv4 at the end, e.g. ::ffff:127.0.0.1 or 0:0:0:0:0:ffff:127.0.0.1
  const lastColon = clean.lastIndexOf(":");
  if (lastColon !== -1) {
    const afterLastColon = clean.slice(lastColon + 1);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(afterLastColon)) {
      const v4Parts = afterLastColon.split(".").map(Number);
      if (
        v4Parts.length === 4 &&
        v4Parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)
      ) {
        const hex1 = (((v4Parts[0] << 8) | v4Parts[1]) >>> 0).toString(16);
        const hex2 = (((v4Parts[2] << 8) | v4Parts[3]) >>> 0).toString(16);
        clean = `${clean.slice(0, lastColon)}:${hex1}:${hex2}`;
      } else {
        return null;
      }
    }
  }

  // Handle :: compression
  const doubleColonIndex = clean.indexOf("::");
  if (doubleColonIndex !== -1) {
    if (clean.indexOf("::", doubleColonIndex + 2) !== -1) {
      return null;
    }
    const leftStr = clean.slice(0, doubleColonIndex);
    const rightStr = clean.slice(doubleColonIndex + 2);
    const leftParts = leftStr ? leftStr.split(":") : [];
    const rightParts = rightStr ? rightStr.split(":") : [];
    const missing = 8 - (leftParts.length + rightParts.length);
    if (missing < 0) return null;
    const parts = [...leftParts, ...Array(missing).fill("0"), ...rightParts];
    if (parts.length !== 8) return null;
    const nums: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      nums.push(parseInt(part, 16));
    }
    return nums;
  } else {
    const parts = clean.split(":");
    if (parts.length !== 8) return null;
    const nums: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      nums.push(parseInt(part, 16));
    }
    return nums;
  }
}

export function isPrivateIPv6(address: string): boolean {
  const nums = parseIpv6Hextets(address);
  if (!nums) {
    // If it cannot be parsed as standard IPv6, fail closed
    return true;
  }

  // Loopback: ::1 or 0:0:0:0:0:0:0:1
  const isLoopback = nums.slice(0, 7).every((n) => n === 0) && nums[7] === 1;

  // Unspecified: :: or 0:0:0:0:0:0:0:0
  const isUnspecified = nums.every((n) => n === 0);

  // IPv4-mapped (::ffff:x.x.x.x or 0:...:0:ffff:x.x.x.x)
  const isIpv4Mapped =
    nums.slice(0, 5).every((n) => n === 0) && nums[5] === 0xffff;

  // IPv4-compatible (::x.x.x.x)
  const isIpv4Compatible =
    nums.slice(0, 6).every((n) => n === 0) && !isLoopback && !isUnspecified;

  if (isIpv4Mapped || isIpv4Compatible) {
    const v4Str = `${(nums[6] >> 8) & 0xff}.${nums[6] & 0xff}.${(nums[7] >> 8) & 0xff}.${nums[7] & 0xff}`;
    if (isPrivateIPv4(v4Str)) {
      return true;
    }
  }

  // Unique local: fc00::/7 (fc00:: - fdff::)
  const isUniqueLocal = (nums[0] & 0xfe00) === 0xfc00;

  // Link-local: fe80::/10 (fe80:: - febf::)
  const isLinkLocal = (nums[0] & 0xffc0) === 0xfe80;

  return isLoopback || isUnspecified || isUniqueLocal || isLinkLocal;
}

export function assertSafeIp(address: string): void {
  const cleanAddr = address.trim().replace(/^\[|\]$/g, "");

  if (cleanAddr.includes(":")) {
    if (isPrivateIPv6(cleanAddr)) {
      throw new Error("URL resolves to a private or internal IP address.");
    }
  } else {
    if (isPrivateIPv4(cleanAddr)) {
      throw new Error("URL resolves to a private or internal IP address.");
    }
  }
}

export async function assertSafeUrl(url: string): Promise<void> {
  installDnsPinHook();
  const { hostname, protocol } = new URL(url);

  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed.");
  }

  const lowerHost = hostname.toLowerCase();
  if (
    lowerHost === "localhost" ||
    lowerHost.endsWith(".localhost") ||
    lowerHost.endsWith(".local") ||
    lowerHost.endsWith(".internal")
  ) {
    throw new Error("URL resolves to a private or internal hostname.");
  }

  const cleanHost = lowerHost.replace(/^\[|\]$/g, "");

  let addresses: string[];
  if (isIP(cleanHost) !== 0) {
    addresses = [cleanHost];
  } else {
    const results = await dns.lookup(cleanHost, { all: true });
    addresses = results.map((r) => r.address);
  }

  if (addresses.length === 0) {
    throw new Error("Unable to resolve hostname.");
  }

  for (const address of addresses) {
    assertSafeIp(address);
  }

  // Pin validated safe IP to prevent DNS rebinding TOCTOU during subsequent outbound request
  pinnedDnsMap.set(lowerHost, addresses[0]);
}

// Helper function to check if a site is active on the domain
export async function hasSiteConfigured(domain: string): Promise<boolean> {
  try {
    // Try HTTP HEAD request first (both HTTP and HTTPS)
    const urls = [`https://${domain}`, `http://${domain}`];

    for (const url of urls) {
      let lowerHost: string | undefined;
      try {
        const { hostname } = new URL(url);
        lowerHost = hostname.toLowerCase();
        await assertSafeUrl(url);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout
        const response = await fetch(url, {
          method: "HEAD",
          signal: controller.signal,
          redirect: "manual",
        });
        clearTimeout(timeoutId);
        if (response.ok || (response.status >= 300 && response.status < 400)) {
          return true;
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          // If request was aborted due to timeout, continue to next check
          continue;
        }
        // Continue to next URL if this one fails
        continue;
      } finally {
        if (lowerHost) {
          pinnedDnsMap.delete(lowerHost);
        }
      }
    }

    // If HTTP checks fail, fallback to dns.resolve with timeout
    const dnsPromise = dns.resolve(domain);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("DNS Timeout")), 3000),
    );
    try {
      const records = (await Promise.race([
        dnsPromise,
        timeoutPromise,
      ])) as string[];

      // Filter out any private/internal IPs
      const safeRecords = records.filter((ip) => {
        try {
          assertSafeIp(ip);
          return true;
        } catch {
          return false;
        }
      });

      return safeRecords.length > 0;
    } catch {
      // If DNS times out or fails, treat as available
      return false;
    }
  } catch {
    // If all checks fail, assume no site is configured
    return false;
  }
}
