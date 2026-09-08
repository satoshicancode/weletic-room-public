"use client";
import { VipCampaignAdmin } from "@/ui/weletic/loyalty/vip-campaign-admin";
import React from "react";

export function TabVip({ workspaceId }: { workspaceId?: string }) {
  return workspaceId
    ? React.createElement(VipCampaignAdmin, { workspaceId })
    : null;
}
