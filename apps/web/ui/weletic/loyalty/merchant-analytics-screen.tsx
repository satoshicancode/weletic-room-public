"use client";

import React, { useRef, useState } from "react";
import {
  merchantAnalyticsFilterSchema,
  type MerchantAnalyticsRequest,
  type MerchantAnalyticsResponse,
  type MerchantAnalyticsSnapshot,
} from "../../../lib/weletic/loyalty/merchant-analytics-contract";
import { merchantAnalyticsCopy } from "./merchant-analytics-copy";

export type MerchantAnalyticsTransport = (
  request: MerchantAnalyticsRequest,
) => Promise<MerchantAnalyticsResponse>;

export function MerchantAnalyticsScreen({
  request,
}: {
  request: MerchantAnalyticsTransport;
}) {
  const [locale, setLocale] =
    useState<keyof typeof merchantAnalyticsCopy>("en");
  const copy = merchantAnalyticsCopy[locale];
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [snapshot, setSnapshot] = useState<MerchantAnalyticsSnapshot | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"invalid" | "error" | null>(null);
  const epoch = useRef(0);
  React.useEffect(() => {
    const fence = epoch;
    const version = ++epoch.current;
    setStart("");
    setEnd("");
    setSnapshot(null);
    setError(null);
    setBusy(true);
    request({ operation: "read", filter: { startAt: null, endAt: null } })
      .then(
        (result) => {
          if (version === epoch.current) setSnapshot(result.snapshot);
        },
        () => {
          if (version === epoch.current) setError("error");
        },
      )
      .finally(() => {
        if (version === epoch.current) setBusy(false);
      });
    return () => {
      fence.current++;
    };
  }, [request]);

  async function run(format?: "csv" | "json") {
    const filter = merchantAnalyticsFilterSchema.safeParse({
      startAt: start ? `${start}T00:00:00.000Z` : null,
      endAt: end ? `${end}T23:59:59.999Z` : null,
    });
    if (!filter.success) {
      setError("invalid");
      return;
    }
    if (format && !snapshot?.canExport) return;
    const version = ++epoch.current;
    setBusy(true);
    setError(null);
    setSnapshot(null);
    try {
      const result = await request(
        format
          ? {
              operation: "export",
              filter: filter.data,
              format,
              expectedInstallationGeneration: snapshot!.installationGeneration,
            }
          : { operation: "read", filter: filter.data },
      );
      if (version !== epoch.current) return;
      setSnapshot(result.snapshot);
      if (result.download) {
        const url = URL.createObjectURL(
          new Blob([result.download.content], {
            type: result.download.contentType,
          }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = result.download.filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch {
      if (version === epoch.current) setError("error");
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  const label = (key: string) => copy[key as keyof typeof copy] ?? key;
  function table(title: string, rows: Record<string, string | null>[]) {
    const keys = rows[0] ? Object.keys(rows[0]) : [];
    return (
      <section>
        <h2>{title}</h2>
        {rows.length ? (
          <div
            role="region"
            aria-label={title}
            tabIndex={0}
            style={{ overflowX: "auto" }}
          >
            <table>
              <thead>
                <tr>
                  {keys.map((key) => (
                    <th key={key} scope="col">
                      {label(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    {keys.map((key) => (
                      <td key={key}>
                        {row[key] === null
                          ? copy.unavailable
                          : key === "status" || key === "artifact"
                            ? row[key] === "expired"
                              ? copy.expiredStatus
                              : label(row[key]!)
                            : row[key]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>{copy.empty}</p>
        )}
      </section>
    );
  }
  function metrics(title: string, values: Record<string, string | null>) {
    return (
      <section>
        <h2>{title}</h2>
        <dl>
          {Object.entries(values).map(([key, value]) => (
            <div key={key}>
              <dt>{label(key)}</dt>
              <dd>{value ?? copy.unavailable}</dd>
            </div>
          ))}
        </dl>
      </section>
    );
  }
  return (
    <article
      className="weletic-analytics"
      lang={locale}
      aria-busy={busy}
      style={{ maxWidth: "100%", overflowWrap: "anywhere" }}
    >
      <h1>{copy.title}</h1>
      <label>
        {copy.language}
        <select
          value={locale}
          onChange={(event) =>
            setLocale(event.target.value as keyof typeof merchantAnalyticsCopy)
          }
        >
          <option value="en">English</option>
          <option value="ja">日本語</option>
          <option value="vi">Tiếng Việt</option>
        </select>
      </label>
      <p>{copy.semantics}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <label>
          {copy.start}
          <input
            type="date"
            value={start}
            onChange={(event) => {
              setStart(event.target.value);
              setSnapshot(null);
              setError(null);
            }}
            disabled={busy}
          />
        </label>
        <label>
          {copy.end}
          <input
            type="date"
            value={end}
            onChange={(event) => {
              setEnd(event.target.value);
              setSnapshot(null);
              setError(null);
            }}
            disabled={busy}
          />
        </label>
        <button type="submit" disabled={busy}>
          {copy.refresh}
        </button>
      </form>
      {busy && <p role="status">{copy.loading}</p>}
      {error && <p role="alert">{copy[error]}</p>}
      {snapshot && (
        <>
          <p>
            {copy.currency}: {snapshot.currency} · {copy.generated}:{" "}
            {snapshot.generatedAt}
          </p>
          {snapshot.financialStatus !== "available" && (
            <p role="status">{copy.financial}</p>
          )}
          <button
            type="button"
            disabled={busy || !snapshot.canExport}
            onClick={() => void run("csv")}
          >
            {copy.csv}
          </button>{" "}
          <button
            type="button"
            disabled={busy || !snapshot.canExport}
            onClick={() => void run("json")}
          >
            {copy.json}
          </button>
          {!snapshot.canExport && <p>{copy.exportNote}</p>}
          {metrics(copy.liability, snapshot.liability)}
          {metrics(copy.activity, snapshot.activity)}
          {metrics(copy.referralEconomics, snapshot.referralEconomics)}
          {table(copy.referrals, snapshot.referrals)}
          {table(copy.rewards, snapshot.rewards)}
          {table(
            copy.tiers,
            snapshot.tiers.map(({ assignment, ...tier }) => ({
              ...tier,
              name: assignment === "configured" ? tier.name : label(assignment),
            })),
          )}
        </>
      )}
    </article>
  );
}
