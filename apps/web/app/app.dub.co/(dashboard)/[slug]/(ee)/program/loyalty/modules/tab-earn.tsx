"use client";
import { EarningRulesAdmin } from "@/ui/weletic/loyalty/earning-rules-admin";

export function TabEarn({
  workspaceId,
  onRefresh,
}: {
  workspaceId: string;
  onRefresh: () => void;
}) {
  return <EarningRulesAdmin workspaceId={workspaceId} onSaved={onRefresh} />;
}
