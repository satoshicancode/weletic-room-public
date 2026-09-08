import { VisibilityState } from "@tanstack/react-table";
import { useCallback, useMemo } from "react";
import { useLocalStorage } from "./use-local-storage";

// Single table configuration
type SingleTableConfig = {
  all: string[];
  defaultVisible: string[];
};

// Multi-tab table configuration
type MultiTableConfig<T extends string> = Record<T, SingleTableConfig>;

// Type guard for SingleTableConfig
function isSingleTableConfig(config: any): config is SingleTableConfig {
  return (
    config &&
    typeof config === "object" &&
    Array.isArray(config.all) &&
    Array.isArray(config.defaultVisible)
  );
}

// Generic hook for single table
export function useColumnVisibility<T extends SingleTableConfig>(
  storageKey: string,
  config: T,
): {
  columnVisibility: VisibilityState;
  setColumnVisibility: (visibility: VisibilityState) => void;
};

// Generic hook for multi-tab table
export function useColumnVisibility<T extends string>(
  storageKey: string,
  config: MultiTableConfig<T>,
): {
  columnVisibility: Record<T, VisibilityState>;
  setColumnVisibility: (tab: T, visibility: VisibilityState) => void;
};

// Implementation
export function useColumnVisibility<T extends string>(
  storageKey: string,
  config: SingleTableConfig | MultiTableConfig<T>,
):
  | {
      columnVisibility: VisibilityState;
      setColumnVisibility: (visibility: VisibilityState) => void;
    }
  | {
      columnVisibility: Record<T, VisibilityState>;
      setColumnVisibility: (tab: T, visibility: VisibilityState) => void;
    } {
  // Check if this is a multi-tab configuration
  const isMultiTab = !isSingleTableConfig(config);

  const defaultState = useMemo(() => {
    if (isMultiTab) {
      const multiConfig = config as MultiTableConfig<T>;
      const getDefaultColumnVisibility = (tab: T) => {
        const columns = multiConfig[tab];
        return Object.fromEntries(
          columns.all.map((id) => [id, columns.defaultVisible.includes(id)]),
        );
      };

      return Object.fromEntries(
        Object.keys(multiConfig).map((tab) => [
          tab,
          getDefaultColumnVisibility(tab as T),
        ]),
      ) as Record<T, VisibilityState>;
    } else {
      const singleConfig = config as SingleTableConfig;
      return Object.fromEntries(
        singleConfig.all.map((id) => [
          id,
          singleConfig.defaultVisible.includes(id),
        ]),
      ) as VisibilityState;
    }
  }, [config, isMultiTab]);

  const [columnVisibility, setColumnVisibilityState] = useLocalStorage<any>(
    storageKey,
    defaultState,
  );

  const setColumnVisibility = useCallback(
    (...args: any[]) => {
      if (isMultiTab) {
        const tab = args[0] as T;
        const visibility = args[1] as VisibilityState;
        const multiConfig = config as MultiTableConfig<T>;
        const allColumns = multiConfig[tab].all;
        const currentTabState =
          (columnVisibility as Record<T, VisibilityState>)[tab] || {};

        const newTabState = Object.fromEntries(
          allColumns.map((columnId) => [
            columnId,
            columnId in visibility
              ? visibility[columnId]
              : currentTabState[columnId] ?? false,
          ]),
        );

        setColumnVisibilityState({
          ...(columnVisibility as Record<T, VisibilityState>),
          [tab]: newTabState,
        });
      } else {
        const visibility = args[0] as VisibilityState;
        const singleConfig = config as SingleTableConfig;
        const allColumns = singleConfig.all;
        const currentState = columnVisibility || {};

        const newState = Object.fromEntries(
          allColumns.map((columnId) => [
            columnId,
            columnId in visibility
              ? visibility[columnId]
              : currentState[columnId] ?? false,
          ]),
        );

        setColumnVisibilityState(newState);
      }
    },
    [config, isMultiTab, columnVisibility, setColumnVisibilityState],
  );

  return {
    columnVisibility,
    setColumnVisibility: setColumnVisibility as any,
  };
}
