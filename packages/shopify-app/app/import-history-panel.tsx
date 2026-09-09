import { useEffect, useRef, useState } from "react";
import type { verifyHistoricalImportHistoryResponse } from "../../../apps/web/lib/weletic/loyalty/historical-import-contract";
import type { ReconcileImport } from "./import-reconciliation-panel";
import {
  ImportStatusPanel,
  importStatusCopy,
  type ExecuteImport,
  type ReadImportStatus,
} from "./import-status-panel";

type History = ReturnType<typeof verifyHistoricalImportHistoryResponse>;
export type ReadImportHistory = (request: unknown) => Promise<History>;
const copy = {
  en: {
    title: "Import history",
    load: "Load latest imports",
    next: "Older imports",
    empty: "No imports on this page.",
    loading: "Loading import history…",
    error:
      "Import history could not be loaded. Load latest imports to try again.",
    view: "View status",
    state: "Saved state",
  },
  ja: {
    title: "インポート履歴",
    load: "最新のインポートを読み込む",
    next: "以前のインポート",
    empty: "このページにインポートはありません。",
    loading: "インポート履歴を読み込み中…",
    error:
      "インポート履歴を読み込めませんでした。最新のインポートを再読み込みしてください。",
    view: "状態を確認",
    state: "保存された状態",
  },
  vi: {
    title: "Lịch sử nhập dữ liệu",
    load: "Tải các bản nhập mới nhất",
    next: "Các bản nhập cũ hơn",
    empty: "Không có bản nhập nào trên trang này.",
    loading: "Đang tải lịch sử nhập…",
    error:
      "Không tải được lịch sử nhập. Hãy tải các bản nhập mới nhất để thử lại.",
    view: "Xem trạng thái",
    state: "Trạng thái đã lưu",
  },
};
/** Parent remounts on store/generation changes and removes on permission loss. */
export function ImportHistoryPanel({
  generation,
  locale,
  readHistory,
  readStatus,
  reconcile,
  execute,
}: {
  generation: string;
  locale: keyof typeof copy;
  readHistory: ReadImportHistory;
  readStatus: ReadImportStatus;
  reconcile: ReconcileImport;
  execute: ExecuteImport;
}) {
  const text = copy[locale];
  const labels = importStatusCopy[locale];
  const [page, setPage] = useState<History | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const running = useRef(false);
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  async function load(before?: NonNullable<History["nextCursor"]>) {
    if (running.current) return;
    const version = epoch.current;
    running.current = true;
    setBusy(true);
    setFailed(false);
    setPage(null);
    setSelected(null);
    try {
      const value = await readHistory({
        operation: "history",
        expectedInstallationGeneration: generation,
        ...(before ? { before } : {}),
      });
      if (epoch.current === version) setPage(value);
    } catch {
      if (epoch.current === version) setFailed(true);
    } finally {
      if (epoch.current === version) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section aria-busy={busy}>
      <h2>{text.title}</h2>
      <p>{labels.notice}</p>
      <button disabled={busy} onClick={() => void load()}>
        {text.load}
      </button>
      <p role="status" aria-live="polite">
        {busy
          ? text.loading
          : failed
            ? text.error
            : page && !page.sources.length
              ? text.empty
              : ""}
      </p>
      {page && page.sources.length > 0 && (
        <div
          role="region"
          aria-label={text.title}
          tabIndex={0}
          style={{ overflowX: "auto" }}
        >
          <table style={{ whiteSpace: "nowrap", borderSpacing: "12px 8px" }}>
            <thead>
              <tr>
                <th scope="col">{labels.created}</th>
                <th scope="col">{text.state}</th>
                <th scope="col">{labels.rows}</th>
                <th scope="col">{labels.total}</th>
                <th scope="col">{text.view}</th>
              </tr>
            </thead>
            <tbody>
              {page.sources.map((source, index) => (
                <tr key={source.sourceId}>
                  <td>
                    <time dateTime={source.createdAt}>{source.createdAt}</time>
                  </td>
                  <td>{labels.statuses[source.status]}</td>
                  <td>{source.rowCount}</td>
                  <td>{source.totalOpeningBalance}</td>
                  <td>
                    <button
                      aria-label={`${text.view}: ${index + 1}, ${source.createdAt}`}
                      onClick={() => setSelected(source.sourceId)}
                    >
                      {text.view}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page?.nextCursor && (
        <button disabled={busy} onClick={() => void load(page.nextCursor!)}>
          {text.next}
        </button>
      )}
      {selected && (
        <ImportStatusPanel
          key={`${generation}:${selected}`}
          sourceId={selected}
          generation={generation}
          locale={locale}
          readStatus={readStatus}
          reconcile={reconcile}
          execute={execute}
        />
      )}
    </section>
  );
}
