import "server-only";

// Cron routes must verify their signature in every production runtime, not only
// on Vercel (the Cloudflare deployment never sets VERCEL). Public development
// tunnels may opt in explicitly. Only server configuration may enable the
// local-development bypass, and only outside production.
export const shouldEnforceCronAuth = () =>
  process.env.NODE_ENV === "production" ||
  process.env.VERCEL === "1" ||
  process.env.WELETIC_ENFORCE_CRON_AUTH === "1";
