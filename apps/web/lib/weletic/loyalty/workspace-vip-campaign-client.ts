import { verifyVipCampaignAcknowledgement } from "./vip-campaign-acknowledgement";
import {
  vipCampaignRequestSchema,
  type VipCampaignRequest,
} from "./vip-campaign-contract";

export function createWorkspaceVipCampaignClient(
  workspaceId: string,
  fetcher: typeof fetch = fetch,
) {
  if (!workspaceId.trim()) throw new Error("Workspace is required");
  const url = `/api/weletic/vip-campaigns?workspaceId=${encodeURIComponent(workspaceId)}`;
  async function request(value: VipCampaignRequest) {
    const input = vipCampaignRequestSchema.parse(value);
    const response = await fetcher(url, {
      method: input.operation === "read" ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
      ...(input.operation === "read"
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          }),
    });
    if (!response.ok) throw new Error("VIP and campaign request failed");
    return verifyVipCampaignAcknowledgement(input, await response.json());
  }
  return {
    read: () => request({ operation: "read" }),
    mutate: (input: Exclude<VipCampaignRequest, { operation: "read" }>) =>
      request(input),
  };
}
