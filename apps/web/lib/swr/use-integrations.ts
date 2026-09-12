import { InstalledIntegrationProps } from "@/lib/types";
import { fetcher } from "@dub/utils";
import useSWR, { SWRConfiguration } from "swr";
import useWorkspace from "./use-workspace";

export default function useIntegrations({
  swrOpts,
}: { swrOpts?: SWRConfiguration } = {}) {
  const { id } = useWorkspace();

  const { data: integrations, error } = useSWR<InstalledIntegrationProps[]>(
    id ? `/api/integrations?workspaceId=${encodeURIComponent(id)}` : null,
    fetcher,
    {
      dedupingInterval: 20000,
      revalidateOnFocus: false,
      ...swrOpts,
      // Never display the previous workspace's configured connections.
      keepPreviousData: false,
    },
  );

  return {
    integrations,
    error,
    loading: !integrations && !error,
  };
}
