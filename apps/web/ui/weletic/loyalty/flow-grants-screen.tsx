"use client";
import { useEffect, useRef, useState } from "react";
import { CreateFlowPointsGrantSchema } from "../../../lib/weletic/loyalty/flow-action-grant-contract";
import {
  FlowGrantsMerchantRequestSchema,
  type FlowGrantListResponse,
  type FlowGrantView,
} from "../../../lib/weletic/loyalty/flow-grants-merchant-contract";
import { flowGrantsCopy } from "./flow-grants-copy";

export type FlowGrantsTransport = {
  scopeKey: string;
  newAttemptId: () => string;
  isNoncommittedError?: (error: unknown) => boolean;
  list: (input?: unknown) => Promise<FlowGrantListResponse>;
  write: (
    input: unknown,
  ) => Promise<{ id: string; revision: number; revokedAt: string | null }>;
};
type Pending =
  | {
      operation: "create";
      attemptId: string;
      input: ReturnType<typeof CreateFlowPointsGrantSchema.parse>;
    }
  | {
      operation: "revoke";
      attemptId: string;
      input: {
        grantId: string;
        expectedRevision: number;
        expectedInstallationGeneration: string;
      };
    };
const journalKey = (generation: string) =>
  `weletic.flow-grant.pending.v1.${generation}`;
// Recovery metadata only: no bearer token, shopper identity or authorization.
// Never dispatch a journal entry: it is exclusively used for signed read-back.
function readJournal(generation: string): Pending | null {
  const raw = sessionStorage.getItem(journalKey(generation));
  if (!raw) return null;
  const request = FlowGrantsMerchantRequestSchema.parse(JSON.parse(raw));
  if (
    request.operation === "list" ||
    request.input.expectedInstallationGeneration !== generation
  )
    throw new Error("Invalid recovery journal");
  return request;
}
export function FlowGrantsSession({
  transport,
}: {
  transport: FlowGrantsTransport;
}) {
  return <FlowGrantsScreen key={transport.scopeKey} transport={transport} />;
}
export function FlowGrantsScreen({
  transport,
}: {
  transport: FlowGrantsTransport;
}) {
  const [locale, setLocale] = useState<keyof typeof flowGrantsCopy>("en");
  const copy = flowGrantsCopy[locale];
  const [view, setView] = useState<FlowGrantListResponse | null>(null);
  const [cursor, setCursor] = useState<string>();
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const live = useRef(true);
  const epoch = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);
  const lastGeneration = useRef<string | undefined>(undefined);
  const [message, setMessage] = useState<
    "loading" | "unavailable" | "uncertain" | "unresolved" | "saved" | "invalid"
  >("loading");
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const remember = (value: Pending | null) => {
    pendingRef.current = value;
    setPending(value);
  };
  const current = (version: number) =>
    live.current && epoch.current === version;
  async function refresh(next?: string, version = epoch.current) {
    const data = await transport.list({
      ...(next ? { cursor: next } : {}),
      ...(view
        ? { expectedInstallationGeneration: view.installationGeneration }
        : {}),
    });
    if (current(version)) {
      if (lastGeneration.current !== data.installationGeneration) {
        formRef.current?.reset();
        setConfirmation(null);
      }
      lastGeneration.current = data.installationGeneration;
      if (!pendingRef.current)
        remember(readJournal(data.installationGeneration));
      setView(data);
      setCursor(next);
    }
  }
  useEffect(() => {
    live.current = true;
    const version = ++epoch.current;
    locked.current = true;
    setBusy(true);
    setView(null);
    setCursor(undefined);
    setConfirmation(null);
    formRef.current?.reset();
    transport
      .list()
      .then((data) => {
        if (live.current && epoch.current === version) {
          lastGeneration.current = data.installationGeneration;
          if (!pendingRef.current) {
            const restored = readJournal(data.installationGeneration);
            pendingRef.current = restored;
            setPending(restored);
          }
          setView(data);
          setMessage(pendingRef.current ? "uncertain" : "saved");
        }
      })
      .catch(() => {
        if (live.current && epoch.current === version) {
          setView(null);
          setMessage("unavailable");
        }
      })
      .finally(() => {
        if (live.current && epoch.current === version) {
          locked.current = false;
          setBusy(false);
        }
      });
    return () => {
      live.current = false;
    };
  }, [transport]);
  async function load(next?: string) {
    if (locked.current || pendingRef.current) return;
    const version = epoch.current;
    locked.current = true;
    setBusy(true);
    try {
      await refresh(next, version);
      if (current(version))
        setMessage(pendingRef.current ? "uncertain" : "saved");
    } catch {
      if (current(version)) {
        setView(null);
        setMessage("unavailable");
      }
    } finally {
      if (current(version)) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  async function write(operation: Pending) {
    if (locked.current || pendingRef.current || !view) return;
    try {
      const existing = readJournal(view.installationGeneration);
      if (existing) {
        remember(existing);
        setMessage("uncertain");
        return;
      }
      sessionStorage.setItem(
        journalKey(view.installationGeneration),
        JSON.stringify(operation),
      );
    } catch {
      setView(null);
      setMessage("unavailable");
      return;
    }
    const version = epoch.current;
    locked.current = true;
    setBusy(true);
    remember(operation);
    setConfirmation(null);
    try {
      await transport.write({
        operation: operation.operation,
        attemptId: operation.attemptId,
        input: operation.input,
      });
      if (!current(version)) return;
      if (operation.operation === "create") formRef.current?.reset();
      sessionStorage.removeItem(
        journalKey(operation.input.expectedInstallationGeneration),
      );
      remember(null);
      setMessage("saved");
      try {
        await refresh(undefined, version);
      } catch {
        if (current(version)) {
          setView(null);
          setMessage("unavailable");
        }
      }
    } catch (error) {
      if (current(version) && transport.isNoncommittedError?.(error)) {
        try {
          sessionStorage.removeItem(
            journalKey(operation.input.expectedInstallationGeneration),
          );
          remember(null);
          const consent = formRef.current?.elements.namedItem("consent");
          if (consent instanceof HTMLInputElement) consent.checked = false;
          setMessage("invalid");
          return;
        } catch {
          /* Keep the original attempt when persistence is unavailable. */
        }
      }
      if (current(version)) {
        setView(null);
        setMessage("uncertain");
      }
    } finally {
      if (current(version)) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  async function reconcile() {
    const operation = pendingRef.current;
    if (locked.current || !operation) return;
    const version = epoch.current;
    locked.current = true;
    setBusy(true);
    try {
      const data = await transport.list({
        expectedInstallationGeneration:
          operation.input.expectedInstallationGeneration,
        ...(operation.operation === "create"
          ? { approvalRequestId: operation.attemptId }
          : { grantId: operation.input.grantId }),
      });
      if (!current(version)) return;
      const found =
        operation.operation === "create"
          ? data.grants.length === 1 &&
            matchesCreate(data.grants[0], operation.input)
          : data.grants.some(
              (grant) =>
                grant.id === operation.input.grantId &&
                grant.revision > operation.input.expectedRevision &&
                grant.revokedAt !== null,
            );
      if (!found) {
        setMessage("unresolved");
        return;
      }
      sessionStorage.removeItem(
        journalKey(operation.input.expectedInstallationGeneration),
      );
      remember(null);
      setMessage("saved");
      if (operation.operation === "create") formRef.current?.reset();
      try {
        await refresh(undefined, version);
      } catch {
        if (current(version)) {
          setView(null);
          setMessage("unavailable");
        }
      }
    } catch {
      if (current(version)) {
        setView(null);
        setMessage("unresolved");
      }
    } finally {
      if (current(version)) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  function attempt(
    operation:
      | Omit<Extract<Pending, { operation: "create" }>, "attemptId">
      | Omit<Extract<Pending, { operation: "revoke" }>, "attemptId">,
  ) {
    try {
      void write({ ...operation, attemptId: transport.newAttemptId() });
    } catch {
      setMessage("unavailable");
    }
  }
  const disabled = busy || !!pending || !view;
  return (
    <section
      className="weletic-flow mx-auto max-w-3xl space-y-4 p-4"
      aria-busy={busy}
      lang={locale}
    >
      <h1 className="text-xl font-semibold">{copy.title}</h1>
      <label>
        {copy.language}{" "}
        <select
          value={locale}
          onChange={(event) =>
            setLocale(event.target.value as keyof typeof flowGrantsCopy)
          }
        >
          <option value="en">English</option>
          <option value="ja">日本語</option>
          <option value="vi">Tiếng Việt</option>
        </select>
      </label>
      <p>{copy.intro}</p>
      <p role="status">{copy[message]}</p>
      {pending && (
        <button type="button" disabled={busy} onClick={() => void reconcile()}>
          {copy.check}
        </button>
      )}
      <button
        type="button"
        disabled={busy || !!pending}
        onClick={() => void load()}
      >
        {copy.reload}
      </button>
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !view) return;
          const form = new FormData(event.currentTarget),
            date = new Date(String(form.get("expires")));
          if (
            !Number.isFinite(date.getTime()) ||
            date.getTime() <= Date.now() ||
            form.get("consent") !== "on"
          ) {
            setMessage("invalid");
            return;
          }
          const parsed = CreateFlowPointsGrantSchema.safeParse({
            allowCredit: form.get("credit") === "on",
            allowDebit: form.get("debit") === "on",
            maxAbsolutePointsPerAction: form.get("maximum"),
            absolutePointsBudget: form.get("budget"),
            expiresAt: date.toISOString(),
            expectedRevision: 0,
            expectedInstallationGeneration: view.installationGeneration,
          });
          if (!parsed.success) {
            setMessage("invalid");
            return;
          }
          attempt({ operation: "create", input: parsed.data });
        }}
      >
        <fieldset disabled={disabled} className="space-y-3 rounded border p-3">
          <legend>{copy.create}</legend>
          <label className="block">
            <input type="checkbox" name="credit" /> {copy.credit}
          </label>
          <label className="block">
            <input type="checkbox" name="debit" /> {copy.debit}
          </label>
          <label className="block">
            {copy.maximum}
            <input
              className="block w-full border p-2"
              name="maximum"
              inputMode="numeric"
              required
            />
          </label>
          <label className="block">
            {copy.budget}
            <input
              className="block w-full border p-2"
              name="budget"
              inputMode="numeric"
              required
            />
          </label>
          <label className="block">
            {copy.expires}
            <input
              className="block w-full min-w-0 border p-2"
              name="expires"
              type="datetime-local"
              required
            />
          </label>
          <label className="block">
            <input type="checkbox" name="consent" required /> {copy.consent}
          </label>
          <button type="submit">{copy.create}</button>
        </fieldset>
      </form>
      {view?.grants.length === 0 && <p>{copy.empty}</p>}
      {view?.grants.map((grant) => (
        <article className="space-y-2 rounded border p-3" key={grant.id}>
          <label className="block">
            {copy.id}
            <input
              readOnly
              className="block w-full border p-2"
              value={grant.id}
            />
          </label>
          <p>
            {copy.status}: {copy[grant.status]} · {copy.remaining}:{" "}
            {grant.remainingAbsolutePoints}
          </p>
          <p>
            {copy.maximum}: {grant.maxAbsolutePointsPerAction} · {copy.budget}:{" "}
            {grant.absolutePointsBudget}
          </p>
          <p>
            {grant.allowCredit ? copy.credit : ""}{" "}
            {grant.allowDebit ? copy.debit : ""}
          </p>
          <time dateTime={grant.expiresAt}>
            {new Date(grant.expiresAt).toLocaleString(locale)}
          </time>
          {!grant.revokedAt &&
            (confirmation === grant.id ? (
              <div>
                <button
                  disabled={disabled}
                  onClick={() =>
                    attempt({
                      operation: "revoke",
                      input: {
                        grantId: grant.id,
                        expectedRevision: grant.revision,
                        expectedInstallationGeneration:
                          view.installationGeneration,
                      },
                    })
                  }
                >
                  {copy.confirm}
                </button>
                <button
                  disabled={disabled}
                  onClick={() => setConfirmation(null)}
                >
                  {copy.cancel}
                </button>
              </div>
            ) : (
              <button
                disabled={disabled}
                onClick={() => setConfirmation(grant.id)}
              >
                {copy.revoke}
              </button>
            ))}
        </article>
      ))}
      <div>
        <button disabled={disabled || !cursor} onClick={() => void load()}>
          {copy.first}
        </button>
        <button
          disabled={disabled || !view?.nextCursor}
          onClick={() => void load(view?.nextCursor ?? undefined)}
        >
          {copy.next}
        </button>
      </div>
    </section>
  );
}
function matchesCreate(
  grant: FlowGrantView,
  input: ReturnType<typeof CreateFlowPointsGrantSchema.parse>,
) {
  return (
    grant.allowCredit === input.allowCredit &&
    grant.allowDebit === input.allowDebit &&
    grant.maxAbsolutePointsPerAction === input.maxAbsolutePointsPerAction &&
    grant.absolutePointsBudget === input.absolutePointsBudget &&
    grant.expiresAt === input.expiresAt
  );
}
