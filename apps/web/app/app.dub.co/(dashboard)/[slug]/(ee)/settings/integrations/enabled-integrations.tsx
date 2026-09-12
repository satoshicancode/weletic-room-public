"use client";

import useIntegrations from "@/lib/swr/use-integrations";
import useWorkspace from "@/lib/swr/use-workspace";
import { IntegrationInventoryList } from "@/ui/integrations/integration-inventory-list";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

export function EnabledIntegrations() {
  const searchParams = useSearchParams();
  const search = searchParams.get("search");

  const { slug } = useWorkspace();
  const {
    integrations: activeIntegrations,
    error,
    loading,
  } = useIntegrations();

  if (search) return null;
  if (error)
    return (
      <p role="alert">
        Integration inventory is unavailable. Refresh this page to try again.
      </p>
    );
  if (loading || !slug)
    return <p role="status">Loading configured integrations…</p>;

  return activeIntegrations?.length ? (
    <AnimatePresence initial={false}>
      {!search && (
        <motion.div
          key="enabled-integrations"
          initial={{ opacity: 0, translateY: 10 }}
          animate={{ opacity: 1, translateY: 0 }}
          exit={{ opacity: 0, translateY: 10 }}
          transition={{ duration: 0.1 }}
        >
          <div className="flex items-center justify-between text-sm">
            <h2 className="font-medium leading-4 text-neutral-800">
              Configured integrations
            </h2>
            <Link
              href={`/${slug}/settings/integrations/enabled`}
              className="font-medium leading-4 text-neutral-500 transition-colors duration-100 hover:text-neutral-700"
            >
              View all ({activeIntegrations.length})
            </Link>
          </div>
          <IntegrationInventoryList
            integrations={activeIntegrations.slice(0, 3)}
            workspaceSlug={slug}
          />
        </motion.div>
      )}
    </AnimatePresence>
  ) : null;
}
