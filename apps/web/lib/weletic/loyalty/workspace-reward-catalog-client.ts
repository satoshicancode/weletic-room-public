import { verifyRewardCatalogAcknowledgement } from "./reward-catalog-acknowledgement";
import {
  rewardCatalogRequestSchema,
  type RewardCatalogContain,
  type RewardCatalogWrite,
} from "./reward-catalog-contract";

export function createWorkspaceRewardCatalogClient(
  workspaceId: string,
  fetcher: typeof fetch = fetch,
) {
  if (!workspaceId.trim()) throw new Error("Workspace is required");
  const url = `/api/weletic/reward-catalog?workspaceId=${encodeURIComponent(workspaceId)}`;
  async function request(value: unknown) {
    const input = rewardCatalogRequestSchema.parse(value);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new Error("Reward catalog result is uncertain. Reload before saving"),
        );
      }, 8000);
    });
    const operation = async () => {
      const response = await fetcher(url, {
        method: input.operation === "read" ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        ...(input.operation === "read"
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(input),
            }),
      });
      if (!response.ok) throw new Error("Reward catalog request failed");
      return verifyRewardCatalogAcknowledgement(input, await response.json());
    };
    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    read: () => request({ operation: "read" }),
    save: (input: RewardCatalogWrite) => request({ operation: "save", input }),
    contain: (input: RewardCatalogContain) =>
      request({ operation: "contain", input }),
  };
}
