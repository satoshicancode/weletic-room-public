import { DEFAULT_PAGINATION_LIMIT } from "@dub/utils";
import { useCallback, useMemo } from "react";
import { useTablePagination } from "../table/use-table-pagination";
import { useRouterStuff } from "./use-router-stuff";

export type PaginationState = {
  pageIndex: number;
  pageSize: number;
};

export function usePagination(pageSize = DEFAULT_PAGINATION_LIMIT) {
  const { searchParams, queryParams } = useRouterStuff();
  const pageParam = searchParams.get("page");

  const page = useMemo(() => parseInt(pageParam || "1") || 1, [pageParam]);

  const onPageChange = useCallback(
    (nextPage: number) => {
      queryParams(
        nextPage === 1
          ? { del: "page" }
          : {
              set: {
                page: nextPage.toString(),
              },
            },
      );
    },
    [queryParams],
  );

  const { pagination, setPagination } = useTablePagination({
    pageSize,
    page,
    onPageChange,
  });

  return { pagination, setPagination };
}
