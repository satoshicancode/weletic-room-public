"use client";

import React from "react";
import { createWorkspaceLoyaltyConfigurationClient } from "../../../lib/weletic/loyalty/workspace-configuration-client";
import { LoyaltyConfigurationSession } from "./configuration-screen";

export function LoyaltyConfigurationAdmin({
  workspaceId,
  onSaved,
}: {
  workspaceId: string;
  onSaved: () => void;
}) {
  const client = React.useMemo(
    () => createWorkspaceLoyaltyConfigurationClient(workspaceId),
    [workspaceId],
  );
  const visit = React.useMemo(
    () => ({ workspaceId, active: true }),
    [workspaceId],
  );
  const currentVisit = React.useRef(visit);
  currentVisit.current = visit;
  React.useEffect(() => {
    visit.active = true;
    return () => {
      visit.active = false;
    };
  }, [visit]);
  return (
    <LoyaltyConfigurationSession
      key={workspaceId}
      transport={{
        scopeKey: workspaceId,
        read: client.read,
        save: async (input) => {
          const result = await client.save(input);
          if (visit.active && currentVisit.current === visit) onSaved();
          return result;
        },
      }}
    />
  );
}
