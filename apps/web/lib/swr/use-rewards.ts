import { fetcher } from "@dub/utils";
import useSWR, { SWRConfiguration } from "swr";
import { RewardProps } from "../types";
import useWorkspace from "./use-workspace";

export default function useRewards(
  {
    query,
    enabled = true,
  }: {
    query?: Record<string, any>;
    enabled?: boolean;
  } = {},
  swrOptions?: SWRConfiguration,
) {
  const { id: workspaceId, defaultProgramId } = useWorkspace();

  const {
    data: rewards,
    isLoading,
    isValidating,
    error,
    mutate,
  } = useSWR<RewardProps[]>(
    enabled && workspaceId && defaultProgramId
      ? `/api/rewards?${new URLSearchParams({
          workspaceId,
          ...query,
        } as Record<string, any>).toString()}`
      : null,
    fetcher,
    swrOptions,
  );

  return {
    rewards,
    loading: isLoading,
    isLoading,
    isValidating,
    error,
    mutate,
  };
}
