export interface SessionCookieDomainOptions {
  appDomain?: string;
  nextAuthUrl?: string;
  vercelEnv?: string;
  vercelUrl?: string;
  nextPublicVercelEnv?: string;
}

const SECOND_LEVEL_DOMAINS = new Set([
  "com",
  "co",
  "net",
  "org",
  "edu",
  "gov",
  "in",
]);

function extractApexDomain(hostname: string): string | undefined {
  const parts = hostname.split(".");
  if (parts.length < 2) return undefined;

  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];

  // Handle second-level ccTLD domains like co.uk, com.au, org.vn
  if (parts.length > 2 && SECOND_LEVEL_DOMAINS.has(sld) && tld.length === 2) {
    return parts.slice(-3).join(".");
  }

  return parts.slice(-2).join(".");
}

/**
 * Dynamically resolves the session cookie domain for NextAuth.
 *
 * Rules:
 * 1. Preview environments (process.env.VERCEL_ENV === "preview", NEXT_PUBLIC_VERCEL_ENV === "preview",
 *    or preview URL patterns) MUST return `undefined` (host-only cookie per RFC 6265)
 *    to prevent infinite login redirect loops.
 * 2. Localhost, loopback, and numeric IP addresses MUST return `undefined`.
 * 3. Production custom domains (e.g. app.weletic.com, app.dub.co) extract the apex domain
 *    with a leading dot (e.g. .weletic.com, .dub.co) to allow cross-subdomain SSO sharing.
 * 4. Fallback: if no valid apex domain can be derived, returns `undefined` (safe host-only cookie).
 */
export function getSessionCookieDomain(
  customEnv?: SessionCookieDomainOptions,
): string | undefined {
  const vercelEnv = customEnv?.vercelEnv ?? process.env.VERCEL_ENV;
  const nextPublicVercelEnv =
    customEnv?.nextPublicVercelEnv ?? process.env.NEXT_PUBLIC_VERCEL_ENV;
  const vercelUrl = customEnv?.vercelUrl ?? process.env.VERCEL_URL;

  // 1. Preview environments must use host-only cookies (omitted domain)
  if (
    vercelEnv === "preview" ||
    nextPublicVercelEnv === "preview" ||
    (vercelUrl &&
      (vercelUrl.includes(".vercel.app") || /preview|-git-/i.test(vercelUrl)) &&
      vercelEnv !== "production")
  ) {
    return undefined;
  }

  // 2. Derive configured app domain
  const rawDomain =
    customEnv?.appDomain ??
    process.env.NEXT_PUBLIC_APP_DOMAIN ??
    customEnv?.nextAuthUrl ??
    process.env.NEXTAUTH_URL;

  if (!rawDomain) {
    return undefined;
  }

  try {
    const urlString =
      rawDomain.startsWith("http://") || rawDomain.startsWith("https://")
        ? rawDomain
        : `https://${rawDomain}`;
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();

    // 3. Localhost, IP addresses, and vercel.app must omit domain entirely (host-only cookie)
    if (
      !hostname ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "vercel.app" ||
      hostname.endsWith(".vercel.app") ||
      /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) ||
      hostname.includes(":") ||
      !hostname.includes(".")
    ) {
      return undefined;
    }

    // 4. Extract apex domain
    const apex = extractApexDomain(hostname);
    if (
      !apex ||
      !apex.includes(".") ||
      apex === "vercel.app" ||
      apex.endsWith(".vercel.app") ||
      apex === "localhost"
    ) {
      return undefined;
    }

    return `.${apex}`;
  } catch {
    return undefined;
  }
}
