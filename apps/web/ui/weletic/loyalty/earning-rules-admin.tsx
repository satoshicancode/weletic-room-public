"use client";
import React from "react";
import { createWorkspaceEarningRulesClient } from "../../../lib/weletic/loyalty/workspace-earning-rules-client";
import { EarningRulesSession } from "./earning-rules-screen";

export function EarningRulesAdmin({
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
    const client = createWorkspaceEarningRulesClient(workspaceId);
    const refresh = () => {
      if (visit.active && current.current === visit) notify.current();
    };
    return {
      scopeKey: workspaceId,
      read: client.read,
      save: async (...args: Parameters<typeof client.save>) => {
        const result = await client.save(...args);
        refresh();
        return result;
      },
      retire: async (...args: Parameters<typeof client.retire>) => {
        const result = await client.retire(...args);
        refresh();
        return result;
      },
    };
  }, [workspaceId, visit]);
  return <EarningRulesSession transport={transport} />;
}
