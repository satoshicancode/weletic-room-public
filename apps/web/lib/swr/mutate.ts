import { mutate, type MutatorOptions } from "swr";

const DEFAULT_MUTATE_OPTS: MutatorOptions = { revalidate: true };

/**
 * Revalidate or mutate all SWR cache keys matching a prefix or list of prefixes.
 */
export const mutatePrefix = (
  prefix: string | string[],
  data?: any,
  opts: MutatorOptions = DEFAULT_MUTATE_OPTS,
) =>
  mutate(
    (key) => {
      if (typeof key !== "string") return false;
      return Array.isArray(prefix)
        ? prefix.some((p) => key.startsWith(p))
        : key.startsWith(prefix);
    },
    data,
    opts,
  );

/**
 * Revalidate or mutate all SWR cache keys matching a suffix or list of suffixes.
 */
export const mutateSuffix = (
  suffix: string | string[],
  data?: any,
  opts: MutatorOptions = DEFAULT_MUTATE_OPTS,
) =>
  mutate(
    (key) => {
      if (typeof key !== "string") return false;
      return Array.isArray(suffix)
        ? suffix.some((s) => key.endsWith(s))
        : key.endsWith(suffix);
    },
    data,
    opts,
  );

/**
 * Invalidate all cache keys associated with a partner:
 * 1. Direct partner endpoints (/api/partners/:id, with or without query params & composite flags)
 * 2. Sub-resources (/api/partners/:id/referral, /api/partners/:id/comments, etc.)
 * 3. Parameterized child queries (?partnerId=:id or &partnerId=:id across /api/discount-codes, /api/payouts, etc.)
 * 4. Partner listing & aggregate count queries (/api/partners, /api/partners/count)
 */
export const mutatePartner = async (
  partnerId?: string | null,
  opts: MutatorOptions = DEFAULT_MUTATE_OPTS,
) => {
  if (!partnerId) {
    return mutate(
      (key) =>
        typeof key === "string" &&
        (key === "/api/partners" ||
          key.startsWith("/api/partners?") ||
          key.startsWith("/api/partners/")),
      undefined,
      opts,
    );
  }

  const partnerIdParam = `partnerId=${partnerId}`;
  const partnerEndpointPrefix = `/api/partners/${partnerId}`;

  return mutate(
    (key) => {
      if (typeof key !== "string") return false;

      const hasPartnerIdParam =
        key.includes(`?${partnerIdParam}&`) ||
        key.endsWith(`?${partnerIdParam}`) ||
        key.includes(`&${partnerIdParam}&`) ||
        key.endsWith(`&${partnerIdParam}`);

      const matchesPartnerPath =
        key === partnerEndpointPrefix ||
        key.startsWith(`${partnerEndpointPrefix}?`) ||
        key.startsWith(`${partnerEndpointPrefix}/`);

      return (
        matchesPartnerPath ||
        hasPartnerIdParam ||
        key === "/api/partners" ||
        key.startsWith("/api/partners?") ||
        key.startsWith("/api/partners/count")
      );
    },
    undefined,
    opts,
  );
};

/**
 * Invalidate composite queries specifically or synchronously with child resources.
 */
export const mutateComposite = async (
  partnerId: string,
  opts: MutatorOptions = DEFAULT_MUTATE_OPTS,
) => {
  const partnerEndpointPrefix = `/api/partners/${partnerId}`;

  return mutate(
    (key) => {
      if (typeof key !== "string") return false;

      const matchesPartnerPath =
        key === partnerEndpointPrefix ||
        key.startsWith(`${partnerEndpointPrefix}?`) ||
        key.startsWith(`${partnerEndpointPrefix}/`);

      return matchesPartnerPath && key.includes("includeComposite=true");
    },
    undefined,
    opts,
  );
};

/**
 * Invalidate referral links and associated partner composite cache.
 */
export const mutatePartnerLinks = async (
  partnerId?: string | null,
  opts: MutatorOptions = DEFAULT_MUTATE_OPTS,
) => {
  await Promise.all([
    mutatePrefix(["/api/links", "/api/partner-profile"], undefined, opts),
    mutatePartner(partnerId, opts),
  ]);
};

/**
 * Invalidate discount codes and associated partner composite cache.
 */
export const mutateDiscountCodes = async (
  partnerId?: string | null,
  opts: MutatorOptions = DEFAULT_MUTATE_OPTS,
) => {
  await Promise.all([
    mutatePrefix("/api/discount-codes", undefined, opts),
    mutatePartner(partnerId, opts),
  ]);
};

/**
 * Invalidate commissions, payouts, and partner stats.
 */
export const mutateCommissions = async (
  partnerId?: string | null,
  opts: MutatorOptions = DEFAULT_MUTATE_OPTS,
) => {
  await Promise.all([
    mutatePrefix(
      [
        "/api/commissions",
        "/api/payouts",
        "/api/programs",
        "/api/analytics",
        "/api/partners/analytics",
      ],
      undefined,
      opts,
    ),
    mutatePartner(partnerId, opts),
  ]);
};

/**
 * Invalidate payouts and partner balances.
 */
export const mutatePayouts = async (
  partnerId?: string | null,
  opts: MutatorOptions = DEFAULT_MUTATE_OPTS,
) => {
  await Promise.all([
    mutatePrefix(
      [
        "/api/payouts",
        "/api/programs",
        "/api/commissions",
        "/api/partner-profile",
      ],
      undefined,
      opts,
    ),
    mutatePartner(partnerId, opts),
  ]);
};
