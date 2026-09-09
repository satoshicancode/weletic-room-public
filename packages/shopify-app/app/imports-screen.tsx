import { useEffect, useRef, useState } from "react";
import type { verifyHistoricalImportPreparationResponse } from "../../../apps/web/lib/weletic/loyalty/historical-import-contract";
import {
  ImportHistoryPanel,
  type ReadImportHistory,
} from "./import-history-panel";
import type { ReconcileImport } from "./import-reconciliation-panel";
import {
  ImportStatusPanel,
  type ExecuteImport,
  type ReadImportStatus,
} from "./import-status-panel";
import { importsCopy } from "./imports-copy";
import { prepareMerchantImportFile } from "./merchant-import-file";

type Response = ReturnType<typeof verifyHistoricalImportPreparationResponse>;
type Upload = Awaited<ReturnType<typeof prepareMerchantImportFile>>;
export function ImportsScreen({
  generation,
  configure,
  request,
  readStatus,
  readHistory,
  reconcile,
  execute,
  initialLocale = "en",
}: {
  generation: string;
  configure: boolean;
  request: (input: unknown) => Promise<Response>;
  readStatus: ReadImportStatus;
  readHistory: ReadImportHistory;
  reconcile: ReconcileImport;
  execute: ExecuteImport;
  initialLocale?: keyof typeof importsCopy;
}) {
  const [locale, setLocale] = useState<keyof typeof importsCopy>(initialLocale);
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [upload, setUpload] = useState<Upload | null>(null);
  const [preview, setPreview] = useState<Extract<
    Response,
    { valid: boolean }
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [stagedSourceId, setStagedSourceId] = useState<string | null>(null);
  const [message, setMessage] = useState<"error" | "staged" | null>(null);
  const [page, setPage] = useState(0);
  const running = useRef(false);
  const epoch = useRef(0);
  const copy = importsCopy[locale];
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  async function selectFile(file?: File) {
    if (running.current || !configure) return;
    const version = ++epoch.current;
    setUpload(null);
    setStagedSourceId(null);
    setPreview(null);
    setMessage(null);
    setPage(0);
    if (!file) return;
    running.current = true;
    setBusy(true);
    try {
      const prepared = await prepareMerchantImportFile(file, format);
      if (epoch.current === version) setUpload(prepared);
    } catch {
      if (epoch.current === version) setMessage("error");
    } finally {
      if (epoch.current === version) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function run(operation: "inspect" | "stage") {
    if (
      running.current ||
      !configure ||
      !upload ||
      (operation === "stage" && !preview?.valid)
    )
      return;
    const version = epoch.current;
    running.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await request({
        sourceBase64: upload.sourceBase64,
        request: {
          operation,
          expectedInstallationGeneration: generation,
          source: upload.source,
          ...(operation === "stage"
            ? { expectedRevision: preview!.revision }
            : {}),
        },
      });
      if (epoch.current !== version) return;
      if (operation === "inspect" && "valid" in result) {
        setPreview(result);
        setPage(0);
      } else if (operation === "stage" && "status" in result) {
        setStagedSourceId(result.sourceId);
        setUpload(null);
        setPreview(null);
        setMessage("staged");
      } else throw new Error("Unexpected import response");
    } catch {
      if (epoch.current === version) {
        setMessage("error");
        setPreview(null);
        // An uncertain stage must not leave a one-click retry on the same revision.
        if (operation === "stage") setUpload(null);
      }
    } finally {
      if (epoch.current === version) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section
      lang={locale}
      aria-busy={busy}
      style={{ maxWidth: 960, padding: 16 }}
    >
      <label>
        {copy.language}{" "}
        <select
          value={locale}
          onChange={(event) =>
            setLocale(event.target.value as keyof typeof importsCopy)
          }
        >
          <option value="en">English</option>
          <option value="ja">日本語</option>
          <option value="vi">Tiếng Việt</option>
        </select>
      </label>
      <h1>{copy.title}</h1>
      <p>{copy.notice}</p>
      <p>{copy.help}</p>
      {!configure && <p role="status">{copy.denied}</p>}
      <label>
        {copy.format}{" "}
        <select
          disabled={busy || !configure}
          value={format}
          onChange={(event) => {
            epoch.current++;
            setFormat(event.target.value as "csv" | "json");
            setStagedSourceId(null);
            setUpload(null);
            setPreview(null);
            setMessage(null);
          }}
        >
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
        </select>
      </label>
      <label style={{ display: "block", margin: "16px 0" }}>
        {copy.file}{" "}
        <input
          type="file"
          accept={format === "csv" ? ".csv" : ".json"}
          disabled={busy || !configure}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void selectFile(file);
          }}
        />
      </label>
      {upload && <p>{copy.ready}</p>}
      <button
        disabled={busy || !configure || !upload}
        onClick={() => void run("inspect")}
      >
        {copy.inspect}
      </button>{" "}
      <button
        disabled={busy || !configure || !upload || !preview?.valid}
        onClick={() => void run("stage")}
      >
        {copy.stage}
      </button>
      <p role="status" aria-live="polite">
        {busy ? copy.busy : message ? copy[message] : ""}
      </p>
      {preview && (
        <>
          <p>
            {copy.rows}: {preview.rowCount} · {copy.total}:{" "}
            {preview.totalOpeningBalance}
          </p>
          <div
            role="region"
            aria-label={copy.inspect}
            tabIndex={0}
            style={{ overflowX: "auto" }}
          >
            <table style={{ whiteSpace: "nowrap", borderSpacing: "12px 8px" }}>
              <thead>
                <tr>
                  <th scope="col">{copy.row}</th>
                  <th scope="col">{copy.before}</th>
                  <th scope="col">{copy.after}</th>
                  <th scope="col">{copy.result}</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(page * 20, (page + 1) * 20).map((row) => (
                  <tr key={row.rowNumber}>
                    <td>{row.rowNumber}</td>
                    <td>{row.balanceBefore ?? "—"}</td>
                    <td>{row.balanceAfter ?? "—"}</td>
                    <td>
                      {row.issues.length
                        ? row.issues.map((issue) => copy[issue]).join("; ")
                        : copy.valid}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>
            {copy.previous}
          </button>{" "}
          <button
            disabled={(page + 1) * 20 >= preview.rowCount}
            onClick={() => setPage(page + 1)}
          >
            {copy.next}
          </button>
        </>
      )}
      {configure && stagedSourceId && (
        <ImportStatusPanel
          key={`${generation}:${stagedSourceId}`}
          sourceId={stagedSourceId}
          generation={generation}
          locale={locale}
          readStatus={readStatus}
          reconcile={reconcile}
          execute={execute}
        />
      )}
      {configure && (
        <ImportHistoryPanel
          key={generation}
          generation={generation}
          locale={locale}
          readHistory={readHistory}
          reconcile={reconcile}
          execute={execute}
          readStatus={readStatus}
        />
      )}
    </section>
  );
}
