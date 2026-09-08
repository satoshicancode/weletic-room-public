import { fetcher } from "@dub/utils";
import useSWR, { SWRConfiguration } from "swr";
import { DiscountCodeProps } from "../types";
import useWorkspace from "./use-workspace";

export default function useDiscountCodes(
  {
    partnerId,
    query,
    enabled = true,
  }: {
    partnerId: string | null | undefined;
    query?: Record<string, any>;
    enabled?: boolean;
  },
  swrOptions?: SWRConfiguration,
) {
  const { id: workspaceId } = useWorkspace();

  const {
    data: discountCodes,
    isLoading,
    isValidating,
    error,
    mutate,
  } = useSWR<DiscountCodeProps[]>(
    enabled && workspaceId && partnerId
      ? `/api/discount-codes?${new URLSearchParams({
          workspaceId,
          partnerId,
          ...query,
        } as Record<string, any>).toString()}`
      : null,
    fetcher,
    swrOptions,
  );

  return {
    discountCodes,
    loading: isLoading,
    isLoading,
    isValidating,
    error,
    mutate,
  };
}
