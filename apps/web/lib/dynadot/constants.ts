export const DYNADOT_COUPON = process.env.DYNADOT_COUPON || "";

export const DYNADOT_DOMAIN_DEFAULT_RENEWAL_FEE_CENTS = 1200;

const DEFAULT_ELIGIBLE_WORKSPACES = [
  "clrei1gld0002vs9mzn93p8ik",
  "ws_1JT00MX4K1KQFMT2FEF6413XT",
  "ws_1KJTC56GDYF3P9AHXSAQS5RGW",
];

export function getEligibleDomainRegistrationWorkspaces(): string[] {
  if (process.env.DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES) {
    return process.env.DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_ELIGIBLE_WORKSPACES;
}

export function isWorkspaceEligibleForDomainRegistration(workspace: {
  id: string;
  plan?: string | null;
  flags?: Record<string, any> | null;
}): boolean {
  if (!workspace || !workspace.id) return false;

  // 1. Explicit environment variable configuration
  const envList = process.env.DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES;
  if (envList !== undefined) {
    const list = envList
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.includes("*") || list.includes(workspace.id)) {
      return true;
    }
  }

  // 2. Feature flag check
  if (workspace.flags?.domainRegistration) {
    return true;
  }

  // 3. Paid plans (pro, business, enterprise)
  if (workspace.plan && workspace.plan !== "free") {
    return true;
  }

  // 4. Default fallback list
  return DEFAULT_ELIGIBLE_WORKSPACES.includes(workspace.id);
}

// Dynamic proxy providing backwards-compatible Array interface that resolves dynamically at runtime
export const DOMAIN_REGISTRATION_ELIGIBLE_WORKSPACES: string[] = new Proxy(
  DEFAULT_ELIGIBLE_WORKSPACES,
  {
    get(target, prop, receiver) {
      if (prop === "includes") {
        return (item: string) => {
          const dynamicList = getEligibleDomainRegistrationWorkspaces();
          if (dynamicList.includes("*")) return true;
          return dynamicList.includes(item);
        };
      }
      if (prop === "length") {
        return getEligibleDomainRegistrationWorkspaces().length;
      }
      if (typeof prop === "string" && !isNaN(Number(prop))) {
        return getEligibleDomainRegistrationWorkspaces()[Number(prop)];
      }
      const dynamicList = getEligibleDomainRegistrationWorkspaces();
      const val = Reflect.get(dynamicList, prop);
      return typeof val === "function" ? val.bind(dynamicList) : val;
    },
  },
);
