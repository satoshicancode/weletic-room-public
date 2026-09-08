"use client";
import React from "react";
import { createWorkspaceVipCampaignClient } from "../../../lib/weletic/loyalty/workspace-vip-campaign-client";
import { VipCampaignSession } from "./vip-campaign-screen";

export function VipCampaignAdmin({ workspaceId }: { workspaceId: string }) {
  const transport = React.useMemo(() => {
    const client = createWorkspaceVipCampaignClient(workspaceId);
    return { scopeKey: workspaceId, ...client };
  }, [workspaceId]);
  return <VipCampaignSession key={workspaceId} transport={transport} />;
}
