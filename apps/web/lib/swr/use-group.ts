import { fetcher } from "@dub/utils";
import { useParams } from "next/navigation";
import useSWR, { SWRConfiguration } from "swr";
import { GroupProps } from "../types";
import useWorkspace from "./use-workspace";

export default function useGroup<T = GroupProps>(
  {
    groupIdOrSlug: groupIdOrSlugProp,
    query,
    enabled = true,
  }: {
    groupIdOrSlug?: string;
    query?: Record<string, any>;
    enabled?: boolean;
  } = {},
  swrOptions?: SWRConfiguration,
) {
  const { id: workspaceId } = useWorkspace();
  const { groupSlug: groupSlugParam } = useParams<{ groupSlug: string }>();

  const groupIdOrSlug = groupIdOrSlugProp ?? groupSlugParam;

  const {
    data: group,
    isLoading,
    isValidating,
    error,
    mutate,
  } = useSWR<T>(
    enabled && workspaceId && groupIdOrSlug
      ? `/api/groups/${groupIdOrSlug}?${new URLSearchParams({ workspaceId, ...query }).toString()}`
      : null,
    fetcher,
    swrOptions,
  );

  return {
    group,
    error,
    mutateGroup: mutate,
    mutate,
    loading: isLoading,
    isLoading,
    isValidating,
  };
}
