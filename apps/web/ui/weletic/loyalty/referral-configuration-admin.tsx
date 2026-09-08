"use client";
import React from "react";
import { createWorkspaceReferralConfigurationClient } from "../../../lib/weletic/loyalty/workspace-referral-configuration-client";
import { ReferralConfigurationSession } from "./referral-configuration-screen";

export function ReferralConfigurationAdmin({
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
    const client = createWorkspaceReferralConfigurationClient(workspaceId);
    const refresh = () => {
      if (visit.active && current.current === visit) notify.current();
    };
    return {
      scopeKey: workspaceId,
      read: client.read,
      pause: async (...args: Parameters<typeof client.pause>) => {
        const result = await client.pause(...args);
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
  return <ReferralConfigurationSession transport={transport} />;
}
