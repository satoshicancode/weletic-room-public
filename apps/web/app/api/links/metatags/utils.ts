import { DubApiError } from "@/lib/api/errors";
import { recordMetatags } from "@/lib/upstash";
import {
  linkPreviewImageBase64PrefixRegex,
  publicHostedImageSchema,
} from "@/lib/zod/schemas/images";
import { fetchWithTimeout, isValidUrl } from "@dub/utils";
import { waitUntil } from "@vercel/functions";
import dnsCallback, { promises as dns } from "dns";
import he from "he";
import { isIP } from "net";
import { parse } from "node-html-parser";

export const pinnedMetatagsDnsMap: Map<string, string> = ((
  globalThis as any
).__pinnedDnsMap ??= new Map<string, string>());

export function installMetatagsDnsPinHook() {
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

    if (pinnedMetatagsDnsMap.has(lower)) {
      const pinnedIp = pinnedMetatagsDnsMap.get(lower)!;
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

  const isRestricted = cleanAddr.includes(":")
    ? isPrivateIPv6(cleanAddr)
    : isPrivateIPv4(cleanAddr);

  if (isRestricted) {
    throw new DubApiError({
      code: "bad_request",
      message:
        "Target URL resolves to a restricted private or internal IP address.",
    });
  }
}

export async function assertSafeFetchUrl(
  rawUrl: string,
): Promise<{ hostname: string; safeIp: string }> {
  installMetatagsDnsPinHook();
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new DubApiError({
      code: "bad_request",
      message: "Invalid URL provided.",
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DubApiError({
      code: "bad_request",
      message: "Only http and https protocols are allowed.",
    });
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  ) {
    throw new DubApiError({
      code: "bad_request",
      message: "Requests to localhost or internal hostnames are prohibited.",
    });
  }

  const cleanHostname = hostname.replace(/^\[|\]$/g, "");

  let addresses: string[] = [];
  if (isIP(cleanHostname) !== 0) {
    addresses = [cleanHostname];
  } else {
    try {
      const records = await dns.lookup(cleanHostname, { all: true });
      addresses = records.map((r) => r.address);
    } catch {
      throw new DubApiError({
        code: "bad_request",
        message: "Target host could not be resolved.",
      });
    }
  }

  if (addresses.length === 0) {
    throw new DubApiError({
      code: "bad_request",
      message: "Target host did not resolve to any IP address.",
    });
  }

  for (const ip of addresses) {
    assertSafeIp(ip);
  }

  return { hostname, safeIp: addresses[0] };
}

export const getHtml = async (url: string) => {
  const pinnedHostnames: string[] = [];

  try {
    let currentUrl = url;
    let response: Response | null = null;
    const maxRedirects = 3;

    for (
      let redirectCount = 0;
      redirectCount <= maxRedirects;
      redirectCount++
    ) {
      const { hostname, safeIp } = await assertSafeFetchUrl(currentUrl);
      pinnedMetatagsDnsMap.set(hostname, safeIp);
      if (!pinnedHostnames.includes(hostname)) {
        pinnedHostnames.push(hostname);
      }

      response = await fetchWithTimeout(currentUrl, { redirect: "manual" });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new DubApiError({
            code: "bad_request",
            message: "Redirect response missing Location header.",
          });
        }
        if (redirectCount === maxRedirects) {
          throw new DubApiError({
            code: "bad_request",
            message: "Too many redirects encountered.",
          });
        }
        const nextUrl = new URL(location, currentUrl).toString();
        // Validate redirect target fail-closed against internal/metadata IPs before following
        await assertSafeFetchUrl(nextUrl);
        currentUrl = nextUrl;
        continue;
      }

      break;
    }

    if (!response) {
      return null;
    }

    if (!response.ok) {
      // If we get a 406 or other error, check if it's a Cloudflare-protected site
      const isCloudflare = response.headers.get("server") === "cloudflare";
      if (isCloudflare) {
        console.warn(`Cloudflare-protected site detected: ${url}`);
        return null;
      }
      console.error(`HTTP error! status: ${response.status} for URL: ${url}`);
      return null;
    }

    const text = await response.text();

    // Check if the response contains Cloudflare's challenge page
    if (
      text.includes("challenge-platform") ||
      text.includes("cf-browser-verification")
    ) {
      console.warn(`Cloudflare challenge page detected for: ${url}`);
      return null;
    }

    return text;
  } catch (error) {
    if (error instanceof DubApiError) {
      throw error;
    }
    console.error(`Error fetching ${url}:`, error);
    return null;
  } finally {
    for (const hostname of pinnedHostnames) {
      pinnedMetatagsDnsMap.delete(hostname);
    }
  }
};

export const getHeadChildNodes = (html) => {
  const ast = parse(html); // parse the html into AST format with node-html-parser
  const metaTags = ast.querySelectorAll("meta").map(({ attributes }) => {
    const property = attributes.property || attributes.name || attributes.href;
    return {
      property,
      content: attributes.content,
    };
  });
  const title = ast.querySelector("title")?.innerText;
  const linkTags = ast.querySelectorAll("link").map(({ attributes }) => {
    const { rel, href } = attributes;
    return {
      rel,
      href,
    };
  });

  return { metaTags, title, linkTags };
};

export const getRelativeUrl = (url: string, imageUrl: string) => {
  if (!imageUrl) {
    return null;
  }
  let resolved: string;
  try {
    resolved = isValidUrl(imageUrl)
      ? new URL(imageUrl).toString()
      : (() => {
          const { protocol, host } = new URL(url);
          const baseURL = `${protocol}//${host}`;
          return new URL(imageUrl, baseURL).toString();
        })();
  } catch {
    return null;
  }
  if (linkPreviewImageBase64PrefixRegex.test(resolved)) {
    return resolved;
  }
  // Apply the same image rule as link creation so a scraped preview can't block it:
  // publicHostedImageSchema drops non-public hosts (localhost, IPs) that can't be proxied.
  if (publicHostedImageSchema.safeParse(resolved).success) {
    return resolved;
  }
  return null;
};

const generateFallbackMetadata = (url: string) => {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;
    const path = parsedUrl.pathname;

    // Clean up the path for title
    const pathParts = path.split("/").filter(Boolean);
    const lastPathPart = pathParts[pathParts.length - 1] || "";
    const formattedPath = lastPathPart
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    return {
      title: formattedPath || hostname.replace(/^www\./, ""),
      description: `Visit ${hostname}${path}`,
      image: null,
    };
  } catch (e) {
    return {
      title: url,
      description: "No description available",
      image: null,
    };
  }
};

export const getMetaTags = async (url: string) => {
  await assertSafeFetchUrl(url);
  const html = await getHtml(url);
  if (!html) {
    // If we couldn't fetch the HTML (e.g., due to Cloudflare protection),
    // generate fallback metadata from the URL
    return generateFallbackMetadata(url);
  }

  const { metaTags, title: titleTag, linkTags } = getHeadChildNodes(html);

  const object = {};

  for (const k in metaTags) {
    const { property, content } = metaTags[k];

    // !object[property] → (meaning we're taking the first instance of a metatag and ignoring the rest)
    property &&
      !object[property] &&
      (object[property] = content && he.decode(content));
  }

  for (const m in linkTags) {
    const { rel, href } = linkTags[m];

    // !object[rel] → (ditto the above)
    rel && !object[rel] && (object[rel] = href);
  }

  const title = object["og:title"] || object["twitter:title"] || titleTag;

  const description =
    object["description"] ||
    object["og:description"] ||
    object["twitter:description"];

  const image =
    object["og:image"] ||
    object["twitter:image"] ||
    object["image_src"] ||
    object["icon"] ||
    object["shortcut icon"];

  waitUntil(recordMetatags(url, title && description && image ? false : true));

  return {
    title: title || url,
    description: description || "No description",
    image: getRelativeUrl(url, image),
  };
};
