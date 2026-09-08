import { fetcher } from "@dub/utils";
import useSWR, { SWRConfiguration } from "swr";
import * as z from "zod/v4";
import { GroupProps } from "../types";
import { getGroupsQuerySchema } from "../zod/schemas/groups";
import useWorkspace from "./use-workspace";

const partialQuerySchema = getGroupsQuerySchema.partial();

export default function useGroups<T extends GroupProps = GroupProps>(
  {
    query,
    enabled = true,
  }: {
    query?: z.infer<typeof partialQuerySchema>;
    enabled?: boolean;
  } = {},
  swrOptions?: SWRConfiguration,
) {
  const { id: workspaceId, defaultProgramId } = useWorkspace();

  const { data, isLoading, isValidating, error, mutate } = useSWR<T[]>(
    enabled && workspaceId && defaultProgramId
      ? `/api/groups?${new URLSearchParams({
          workspaceId,
          sortBy: "totalSaleAmount",
          ...(query as Record<string, string>),
        }).toString()}`
      : null,
    fetcher,
    swrOptions,
  );

  return {
    groups: data,
    loading: isLoading,
    isLoading,
    isValidating,
    error,
    mutate,
  };
}
