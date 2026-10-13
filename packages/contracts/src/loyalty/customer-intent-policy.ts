export const CUSTOMER_INTENT_TRIGGER_CODES = [
  "facebook_like",
  "facebook_share",
  "instagram_follow",
  "x_share",
  "x_follow",
  "tiktok_follow",
  "link_click",
] as const;

export type CustomerIntentTriggerCode =
  (typeof CUSTOMER_INTENT_TRIGGER_CODES)[number];

export type CustomerIntentAction = {
  kind: "customer_intent";
  url: string;
  label: string;
  verification: "honor_system";
};

function readJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readHttpsUrl(value: unknown): URL | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

const FOLLOW_HOSTS: Partial<Record<CustomerIntentTriggerCode, Set<string>>> = {
  facebook_like: new Set(["facebook.com", "www.facebook.com"]),
  instagram_follow: new Set(["instagram.com", "www.instagram.com"]),
  x_follow: new Set(["twitter.com", "www.twitter.com", "x.com", "www.x.com"]),
  tiktok_follow: new Set(["tiktok.com", "www.tiktok.com"]),
};

export function isCustomerIntentTriggerCode(
  value: string,
): value is CustomerIntentTriggerCode {
  return CUSTOMER_INTENT_TRIGGER_CODES.includes(
    value as CustomerIntentTriggerCode,
  );
}

export function validateCustomerIntentConditions({
  triggerCode,
  conditions,
}: {
  triggerCode: CustomerIntentTriggerCode;
  conditions: unknown;
}) {
  const record = readJsonRecord(conditions);
  const targetUrl = readHttpsUrl(record.targetUrl);
  if (!targetUrl) {
    throw new Error("This earning action requires a valid HTTPS target URL.");
  }

  const allowedHosts = FOLLOW_HOSTS[triggerCode];
  if (allowedHosts && !allowedHosts.has(targetUrl.hostname.toLowerCase())) {
    throw new Error(
      `The target URL is not valid for the ${triggerCode.replaceAll("_", " ")} action.`,
    );
  }

  const shareMessage =
    typeof record.shareMessage === "string"
      ? record.shareMessage.trim().slice(0, 280)
      : "";

  return {
    targetUrl: targetUrl.toString(),
    ...(shareMessage ? { shareMessage } : {}),
  };
}

export function getCustomerIntentAction({
  triggerCode,
  conditions,
}: {
  triggerCode: string;
  conditions: unknown;
}): CustomerIntentAction | null {
  if (!isCustomerIntentTriggerCode(triggerCode)) return null;

  let config: ReturnType<typeof validateCustomerIntentConditions>;
  try {
    config = validateCustomerIntentConditions({ triggerCode, conditions });
  } catch {
    // Stored invalid configuration must fail closed on customer surfaces.
    return null;
  }

  const target = encodeURIComponent(config.targetUrl);
  const message = encodeURIComponent(config.shareMessage || "");
  if (triggerCode === "facebook_share") {
    return {
      kind: "customer_intent",
      url: `https://www.facebook.com/sharer/sharer.php?u=${target}`,
      label: "Share on Facebook",
      verification: "honor_system",
    };
  }
  if (triggerCode === "x_share") {
    return {
      kind: "customer_intent",
      url: `https://x.com/intent/post?url=${target}${message ? `&text=${message}` : ""}`,
      label: "Share on X",
      verification: "honor_system",
    };
  }

  const labels: Record<
    Exclude<CustomerIntentTriggerCode, "facebook_share" | "x_share">,
    string
  > = {
    facebook_like: "Open Facebook",
    instagram_follow: "Open Instagram",
    x_follow: "Open X",
    tiktok_follow: "Open TikTok",
    link_click: "Open link",
  };
  return {
    kind: "customer_intent",
    url: config.targetUrl,
    label: labels[triggerCode],
    verification: "honor_system",
  };
}
