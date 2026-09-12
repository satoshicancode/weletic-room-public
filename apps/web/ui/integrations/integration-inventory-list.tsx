import { InstalledIntegrationProps } from "@/lib/types";
import { IntegrationLogo } from "@/ui/integrations/integration-logo";
import { IntegrationStatusBadge } from "@/ui/integrations/integration-status-badge";
import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";
import { ChevronRight } from "lucide-react";
import Link from "next/link";

export function IntegrationInventoryList({
  integrations,
  workspaceSlug,
}: {
  integrations: InstalledIntegrationProps[];
  workspaceSlug: string;
}) {
  return (
    <ul className="mt-4 divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200">
      {integrations.map((integration) => (
        <li key={integration.id}>
          <Link
            href={`/${encodeURIComponent(workspaceSlug)}/settings/integrations/${encodeURIComponent(integration.slug)}`}
            className="group flex items-center justify-between gap-3 p-3 pr-5 text-sm hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
          >
            <div className="flex min-w-0 items-center gap-3">
              <IntegrationLogo
                src={integration.logo ?? null}
                alt={integration.name}
              />
              <div className="min-w-0">
                <span className="flex items-center gap-1.5 font-medium text-neutral-800">
                  {integration.name}
                  <IntegrationStatusBadge
                    projectId={integration.projectId}
                    verified={integration.verified}
                  />
                </span>
                <p className="text-xs text-neutral-500">
                  {integration.id === SHOPIFY_INTEGRATION_ID
                    ? "Managed in Shopify · approval and connection status checked separately"
                    : "Enabled"}
                </p>
              </div>
            </div>
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 text-neutral-400"
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}
