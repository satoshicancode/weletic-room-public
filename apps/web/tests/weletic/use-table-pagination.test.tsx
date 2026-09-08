// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTablePagination } from "../../../../packages/ui/src/table/use-table-pagination";

type HookResult = ReturnType<typeof useTablePagination>;

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function PaginationHarness({
  page,
  onPageChange,
  onRender,
}: {
  page: number;
  onPageChange: (page: number) => void;
  onRender: (result: HookResult) => void;
}) {
  onRender(
    useTablePagination({
      page,
      pageSize: 25,
      onPageChange,
    }),
  );
  return null;
}

describe("useTablePagination", () => {
  let container: HTMLDivElement;
  let root: Root;
  let current: HookResult;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderPagination = (
    page: number,
    onPageChange: (page: number) => void,
  ) => {
    act(() => {
      root.render(
        createElement(PaginationHarness, {
          page,
          onPageChange,
          onRender: (result) => {
            current = result;
          },
        }),
      );
    });
  };

  it("syncs a changed page prop without reporting a user page change", () => {
    const onPageChange = vi.fn();
    renderPagination(3, onPageChange);

    renderPagination(1, onPageChange);

    expect(current.pagination.pageIndex).toBe(1);
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("reports a page change from the returned setter exactly once", () => {
    const onPageChange = vi.fn();
    renderPagination(1, onPageChange);

    act(() => {
      current.setPagination((pagination) => ({
        ...pagination,
        pageIndex: 2,
      }));
    });

    expect(current.pagination.pageIndex).toBe(2);
    expect(onPageChange).toHaveBeenCalledOnce();
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("does not write a URL-driven reset back to the previous page", () => {
    const onPageChange = vi.fn();
    renderPagination(3, onPageChange);

    act(() => {
      current.setPagination((pagination) => ({
        ...pagination,
        pageIndex: 4,
      }));
    });
    expect(onPageChange).toHaveBeenCalledWith(4);

    renderPagination(1, onPageChange);

    expect(current.pagination.pageIndex).toBe(1);
    expect(onPageChange).toHaveBeenCalledTimes(1);
  });
});
