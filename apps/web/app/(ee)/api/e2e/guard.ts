import { DubApiError } from "@/lib/api/errors";
import { WorkspaceProps } from "@/lib/types";
import { ACME_WORKSPACE_ID } from "@dub/utils";

export function assertE2EWorkspace(
  workspace: Pick<WorkspaceProps, "id">,
): void {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ENABLE_E2E_ROUTES !== "true"
  ) {
    throw new DubApiError({
      code: "not_found",
      message: "Endpoint not found",
    });
  }

  const allowedWorkspaceId = process.env.E2E_WORKSPACE_ID || ACME_WORKSPACE_ID;

  if (workspace.id !== allowedWorkspaceId) {
    throw new DubApiError({
      code: "forbidden",
      message: "E2E endpoints are restricted to the Acme test workspace.",
    });
  }
}
