"use client";
import { VipCampaignAdmin } from "@/ui/weletic/loyalty/vip-campaign-admin";
import React from "react";

export function TabBonuses({ workspaceId }: { workspaceId: string }) {
  return React.createElement(VipCampaignAdmin, { workspaceId });
}
