import { PaginationState } from "@tanstack/react-table";
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export function useTablePagination({
  pageSize,
  page,
  onPageChange,
}: {
  pageSize: number;
  page: number;
  onPageChange?: (page: number) => void;
}) {
  const [pagination, setPaginationState] = useState<PaginationState>({
    pageIndex: page,
    pageSize,
  });
  const onPageChangeRef = useRef(onPageChange);
  const pendingPageChangeRef = useRef<number | null>(null);

  useEffect(() => {
    onPageChangeRef.current = onPageChange;
  }, [onPageChange]);

  useEffect(() => {
    setPaginationState((current) =>
      current.pageIndex === page
        ? current
        : {
            ...current,
            pageIndex: page,
          },
    );
  }, [page]);

  const setPagination = useCallback(
    (updater: SetStateAction<PaginationState>) => {
      setPaginationState((current) => {
        const next = typeof updater === "function" ? updater(current) : updater;

        if (next.pageIndex !== current.pageIndex) {
          pendingPageChangeRef.current = next.pageIndex;
        }

        return next;
      });
    },
    [],
  );

  useEffect(() => {
    if (pendingPageChangeRef.current !== pagination.pageIndex) return;

    pendingPageChangeRef.current = null;
    onPageChangeRef.current?.(pagination.pageIndex);
  }, [pagination.pageIndex]);

  return { pagination, setPagination };
}
