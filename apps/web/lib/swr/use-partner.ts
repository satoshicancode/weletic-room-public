import { fetcher } from "@dub/utils";
import useSWR, { SWRConfiguration } from "swr";
import { EnrolledPartnerExtendedProps } from "../types";
import useWorkspace from "./use-workspace";

export default function usePartner<T = EnrolledPartnerExtendedProps>(
  {
    partnerId,
    query,
    includeComposite,
    enabled = true,
  }: {
    partnerId: string | null | undefined;
    query?: Record<string, any>;
    includeComposite?: boolean;
    enabled?: boolean;
  },
  swrOptions?: SWRConfiguration,
) {
  const { id: workspaceId } = useWorkspace();

  const queryParams = new URLSearchParams({
    ...(workspaceId ? { workspaceId } : {}),
    ...(includeComposite ? { includeComposite: "true" } : {}),
    ...(query as Record<string, string>),
  }).toString();

  const { data, isLoading, isValidating, error, mutate } = useSWR<T>(
    enabled && partnerId && workspaceId
      ? `/api/partners/${partnerId}?${queryParams}`
      : null,
    fetcher,
    swrOptions,
  );

  return {
    partner: data,
    loading: isLoading,
    isLoading,
    isValidating,
    error,
    mutate,
  };
}
