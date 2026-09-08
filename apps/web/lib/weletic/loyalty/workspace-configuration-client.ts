import {
  loyaltyConfigurationResponseSchema,
  loyaltyConfigurationUpdateSchema,
  type LoyaltyConfigurationUpdate,
} from "./configuration-contract";

function canonicalRate(value: string) {
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function createWorkspaceLoyaltyConfigurationClient(
  workspaceId: string,
  fetcher: typeof fetch = fetch,
) {
  if (!workspaceId.trim()) throw new Error("Workspace is required");
  const url = `/api/weletic/loyalty-configuration?workspaceId=${encodeURIComponent(workspaceId)}`;
  async function request(input?: LoyaltyConfigurationUpdate) {
    const update =
      input === undefined
        ? undefined
        : loyaltyConfigurationUpdateSchema.parse(input);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new Error(
            "Loyalty configuration result is uncertain. Reload before saving",
          ),
        );
      }, 8000);
    });
    const operation = async () => {
      const response = await fetcher(url, {
        signal: controller.signal,
        method: update ? "PATCH" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        ...(update
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(update),
            }
          : {}),
      });
      if (!response.ok) throw new Error("Loyalty configuration request failed");
      const result = loyaltyConfigurationResponseSchema.parse(
        await response.json(),
      );
      if (update) {
        const saved = result.program?.settings;
        if (
          !saved ||
          result.installationGeneration !==
            update.expectedInstallationGeneration ||
          Object.entries(update.settings).some(([key, value]) => {
            if (value === undefined) return false;
            if (key === "pointsPerCurrencyUnit" && typeof value === "string")
              return (
                canonicalRate(saved.pointsPerCurrencyUnit) !==
                canonicalRate(value)
              );
            return saved[key as keyof typeof saved] !== value;
          })
        )
          throw new Error("Loyalty configuration save could not be verified");
      }
      return result;
    };
    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    read: () => request(),
    save: (input: LoyaltyConfigurationUpdate) => request(input),
  };
}
