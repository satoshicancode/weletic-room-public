import { useEffect, useRef, useState } from "react";
import type {
  verifyHistoricalImportExecutionResponse,
  verifyHistoricalImportStatusResponse,
} from "../../../apps/web/lib/weletic/loyalty/historical-import-contract";
import {
  ImportReconciliationPanel,
  type ReconcileImport,
} from "./import-reconciliation-panel";

type Status = ReturnType<typeof verifyHistoricalImportStatusResponse>;
export type ReadImportStatus = (request: unknown) => Promise<Status>;
export type ExecuteImport = (
  request: unknown,
) => Promise<ReturnType<typeof verifyHistoricalImportExecutionResponse>>;
export const importExecutionCopy = {
  en: {
    commit: "Commit opening balances",
    rollback: "Roll back this import",
    confirmCommit:
      "I confirm that these opening balances should be applied. No historical purchases or rewards will be created.",
    confirmRollback:
      "I confirm rollback of this import. Later shopper activity can prevent automatic rollback and require investigation.",
    sending: "Requesting import processing…",
    queued:
      "Processing was queued, not completed. Refresh status and reconcile the ledger to verify the outcome.",
    uncertain:
      "The request outcome could not be confirmed. Refresh status before trying again; processing may already have started.",
  },
  ja: {
    commit: "開始残高を反映",
    rollback: "このインポートをロールバック",
    confirmCommit:
      "開始残高の反映を確認します。過去の購入や特典は作成されません。",
    confirmRollback:
      "このインポートのロールバックを確認します。その後の顧客操作により自動処理できず、調査が必要になる場合があります。",
    sending: "処理を依頼中…",
    queued:
      "処理をキューに登録しました。完了ではありません。状態の更新と台帳の照合で結果を確認してください。",
    uncertain:
      "依頼の結果を確認できませんでした。処理が開始済みの可能性があるため、再試行前に状態を更新してください。",
  },
  vi: {
    commit: "Ghi số dư ban đầu",
    rollback: "Hoàn tác bản nhập này",
    confirmCommit:
      "Tôi xác nhận ghi các số dư ban đầu này. Không tạo giao dịch mua hoặc phần thưởng lịch sử.",
    confirmRollback:
      "Tôi xác nhận hoàn tác bản nhập này. Hoạt động sau đó của khách hàng có thể ngăn hoàn tác tự động và cần kiểm tra.",
    sending: "Đang yêu cầu xử lý…",
    queued:
      "Đã xếp hàng xử lý, chưa hoàn tất. Hãy cập nhật trạng thái và đối soát sổ điểm để xác minh kết quả.",
    uncertain:
      "Chưa xác nhận được kết quả yêu cầu. Hãy cập nhật trạng thái trước khi thử lại vì quá trình xử lý có thể đã bắt đầu.",
  },
};
export const importStatusCopy = {
  en: {
    title: "Import status",
    refresh: "Refresh import status",
    loading: "Loading status…",
    error: "Import status could not be confirmed. Refresh to try again.",
    notice:
      "This is the saved import state, not proof of ledger reconciliation.",
    historical:
      "Created under an earlier installation. Reading status does not restart it.",
    rows: "Rows",
    total: "Opening points",
    created: "Created (UTC)",
    completed: "Completed (UTC)",
    statuses: {
      preview: "Staged",
      committing: "Committing",
      committed: "Committed",
      rolling_back: "Rolling back",
      rolled_back: "Rolled back",
      contained: "Contained — requires investigation",
      cancelled: "Cancelled",
    },
  },
  ja: {
    title: "インポートの状態",
    refresh: "インポートの状態を更新",
    loading: "状態を読み込み中…",
    error:
      "インポートの状態を確認できませんでした。更新して再試行してください。",
    notice:
      "保存されたインポートの状態です。台帳の照合完了を示すものではありません。",
    historical:
      "以前のインストールで作成されました。状態の確認では処理を再開しません。",
    rows: "行数",
    total: "開始ポイント",
    created: "作成日時（UTC）",
    completed: "完了日時（UTC）",
    statuses: {
      preview: "準備保存済み",
      committing: "反映中",
      committed: "反映済み",
      rolling_back: "ロールバック中",
      rolled_back: "ロールバック済み",
      contained: "保留中 — 調査が必要です",
      cancelled: "キャンセル済み",
    },
  },
  vi: {
    title: "Trạng thái nhập dữ liệu",
    refresh: "Cập nhật trạng thái nhập",
    loading: "Đang tải trạng thái…",
    error: "Không xác nhận được trạng thái nhập. Hãy cập nhật để thử lại.",
    notice:
      "Đây là trạng thái nhập đã lưu, không phải bằng chứng sổ điểm đã được đối soát.",
    historical:
      "Được tạo ở lần cài đặt trước. Xem trạng thái không khởi động lại tác vụ.",
    rows: "Số dòng",
    total: "Điểm ban đầu",
    created: "Ngày tạo (UTC)",
    completed: "Ngày hoàn tất (UTC)",
    statuses: {
      preview: "Đã lưu bản chuẩn bị",
      committing: "Đang ghi điểm",
      committed: "Đã ghi điểm",
      rolling_back: "Đang hoàn tác",
      rolled_back: "Đã hoàn tác",
      contained: "Tạm giữ — cần kiểm tra",
      cancelled: "Đã hủy",
    },
  },
};

/** Parent keys this panel by source and installation; identifiers stay in memory. */
export function ImportStatusPanel({
  sourceId,
  generation,
  locale,
  readStatus,
  reconcile,
  execute,
}: {
  sourceId: string;
  generation: string;
  locale: keyof typeof importStatusCopy;
  readStatus: ReadImportStatus;
  reconcile: ReconcileImport;
  execute: ExecuteImport;
}) {
  const text = importStatusCopy[locale];
  const [result, setResult] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [executionMessage, setExecutionMessage] = useState<
    "sending" | "queued" | "uncertain" | null
  >(null);
  const actionText = importExecutionCopy[locale];
  const operation =
    result?.sourceInstallationGeneration === generation
      ? result.status === "preview"
        ? "commit"
        : result.status === "committed"
          ? "rollback"
          : null
      : null;
  const running = useRef(false);
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  async function refresh() {
    if (running.current) return;
    const version = epoch.current;
    running.current = true;
    setBusy(true);
    setFailed(false);
    setConfirmed(false);
    setExecutionMessage(null);
    // Never present an older success as a current result after a failed refresh.
    setResult(null);
    setRefreshVersion((value) => value + 1);
    try {
      const value = await readStatus({
        operation: "status",
        sourceId,
        expectedInstallationGeneration: generation,
      });
      if (epoch.current === version) setResult(value);
    } catch {
      if (epoch.current === version) setFailed(true);
    } finally {
      if (epoch.current === version) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function start() {
    if (running.current || !result || !operation || !confirmed) return;
    const request = {
      operation,
      sourceId,
      expectedInstallationGeneration: generation,
      expectedRevision: result.revision,
    };
    const version = epoch.current;
    running.current = true;
    setBusy(true);
    setConfirmed(false);
    setFailed(false);
    setExecutionMessage("sending");
    // Invalidate the old revision and any in-flight reconciliation before sending.
    setResult(null);
    setRefreshVersion((value) => value + 1);
    try {
      await execute(request);
      if (epoch.current === version) setExecutionMessage("queued");
    } catch {
      // A timeout can occur after the server commits. Never retry a write here.
      if (epoch.current === version) setExecutionMessage("uncertain");
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
      <p>{text.notice}</p>
      <button disabled={busy} onClick={() => void refresh()}>
        {text.refresh}
      </button>
      <p role="status" aria-live="polite">
        {executionMessage
          ? actionText[executionMessage]
          : busy
            ? text.loading
            : failed
              ? text.error
              : result
                ? text.statuses[result.status]
                : ""}
      </p>
      {result && (
        <>
          {result.sourceInstallationGeneration !== generation && (
            <p>{text.historical}</p>
          )}
          <dl>
            <dt>{text.rows}</dt>
            <dd>{result.rowCount}</dd>
            <dt>{text.total}</dt>
            <dd>{result.totalOpeningBalance}</dd>
            <dt>{text.created}</dt>
            <dd>
              <time dateTime={result.createdAt}>{result.createdAt}</time>
            </dd>
            <dt>{text.completed}</dt>
            <dd>
              {result.completedAt ? (
                <time dateTime={result.completedAt}>{result.completedAt}</time>
              ) : (
                "—"
              )}
            </dd>
          </dl>
          {operation && (
            <div>
              <label style={{ display: "block", margin: "16px 0" }}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />{" "}
                {operation === "commit"
                  ? actionText.confirmCommit
                  : actionText.confirmRollback}
              </label>
              <button
                disabled={busy || !confirmed}
                onClick={() => void start()}
              >
                {actionText[operation]}
              </button>
            </div>
          )}
          <ImportReconciliationPanel
            key={`${result.revision}:${refreshVersion}`}
            sourceId={sourceId}
            generation={generation}
            revision={result.revision}
            locale={locale}
            reconcile={reconcile}
          />
        </>
      )}
    </section>
  );
}
