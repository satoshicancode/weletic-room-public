import "server-only";

// Public development tunnels must opt in before accepting cron traffic.
// Only server configuration may enable the local-development bypass.
export const shouldEnforceCronAuth = () =>
  process.env.VERCEL === "1" || process.env.WELETIC_ENFORCE_CRON_AUTH === "1";
