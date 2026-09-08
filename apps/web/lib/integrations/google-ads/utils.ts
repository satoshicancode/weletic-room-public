import { normalizeWorkspaceId } from "@/lib/api/workspaces/workspace-id";
import { GOOGLE_ADS_ALLOWED_WORKSPACE_IDS } from "./constants";

export const isGoogleAdsAllowedWorkspace = (workspaceId: string) =>
  process.env.NODE_ENV === "development" ||
  !process.env.DUB_WORKSPACE_ID ||
  GOOGLE_ADS_ALLOWED_WORKSPACE_IDS.has(normalizeWorkspaceId(workspaceId));
