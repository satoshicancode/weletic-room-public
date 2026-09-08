"use client";
import { RewardCatalogAdmin } from "@/ui/weletic/loyalty/reward-catalog-admin";

export function TabRewards({
  workspaceId,
  onRefresh,
}: {
  workspaceId: string;
  onRefresh: () => void;
}) {
  return <RewardCatalogAdmin workspaceId={workspaceId} onSaved={onRefresh} />;
}
