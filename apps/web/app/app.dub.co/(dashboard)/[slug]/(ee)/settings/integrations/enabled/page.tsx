"use client";

import useIntegrations from "@/lib/swr/use-integrations";
import useWorkspace from "@/lib/swr/use-workspace";
import { IntegrationInventoryList } from "@/ui/integrations/integration-inventory-list";

/** Fetch through the workspace-authorized API. A client layout is not
 * authorization for a server query using an untrusted route slug.
 */
export default function EnabledIntegrationsPage() {
  const { slug } = useWorkspace();
  const { integrations, error, loading } = useIntegrations();
  if (error)
    return (
      <p role="alert">
        Integration inventory is unavailable. Refresh this page to try again.
      </p>
    );
  if (loading || !slug)
    return <p role="status">Loading configured integrations…</p>;
  return (
    <section>
      <h1 className="text-lg font-semibold">Configured integrations</h1>
      {integrations?.length ? (
        <IntegrationInventoryList
          integrations={integrations}
          workspaceSlug={slug}
        />
      ) : (
        <p className="mt-4 text-sm text-neutral-600">
          No integrations configured for this workspace.
        </p>
      )}
    </section>
  );
}
