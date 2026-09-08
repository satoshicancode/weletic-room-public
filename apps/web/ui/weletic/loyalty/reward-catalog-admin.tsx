"use client";
import React from "react";
import { createWorkspaceRewardCatalogClient } from "../../../lib/weletic/loyalty/workspace-reward-catalog-client";
import { RewardCatalogSession } from "./reward-catalog-screen";

export function RewardCatalogAdmin({
  workspaceId,
  onSaved,
}: {
  workspaceId: string;
  onSaved: () => void;
}) {
  const notify = React.useRef(onSaved);
  notify.current = onSaved;
  const visit = React.useMemo(
    () => ({ workspaceId, active: true }),
    [workspaceId],
  );
  const current = React.useRef(visit);
  current.current = visit;
  React.useEffect(() => {
    visit.active = true;
    return () => {
      visit.active = false;
    };
  }, [visit]);
  const transport = React.useMemo(() => {
    const client = createWorkspaceRewardCatalogClient(workspaceId);
    const refresh = () => {
      if (visit.active && current.current === visit) notify.current();
    };
    return {
      scopeKey: workspaceId,
      read: client.read,
      contain: async (...args: Parameters<typeof client.contain>) => {
        const result = await client.contain(...args);
        refresh();
        return result;
      },
      save: async (...args: Parameters<typeof client.save>) => {
        const result = await client.save(...args);
        refresh();
        return result;
      },
    };
  }, [workspaceId, visit]);
  return <RewardCatalogSession transport={transport} />;
}
