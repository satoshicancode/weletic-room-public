import { useEffect, useRef, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { CreateFlowPointsGrantSchema } from "@weletic/contracts/loyalty/flow-action-grant-contract";
import {
  FlowGrantsMerchantRequestSchema,
  type FlowGrantListResponse,
  type FlowGrantView,
} from "@weletic/contracts/loyalty/flow-grants-merchant-contract";
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
  const shopify = useAppBridge();
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
  const [allowCredit, setAllowCredit] = useState(false);
  const [allowDebit, setAllowDebit] = useState(false);
  const [maximum, setMaximum] = useState("");
  const [budget, setBudget] = useState("");
  const [expires, setExpires] = useState("");
  const [consent, setConsent] = useState(false);
  const resetForm = () => {
    setAllowCredit(false);
    setAllowDebit(false);
    setMaximum("");
    setBudget("");
    setExpires("");
    setConsent(false);
    formRef.current?.reset();
  };
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
        resetForm();
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
      shopify.toast?.show?.(copy.unavailable, { isError: true });
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
      if (operation.operation === "create") resetForm();
      sessionStorage.removeItem(
        journalKey(operation.input.expectedInstallationGeneration),
      );
      remember(null);
      setMessage("saved");
      shopify.toast?.show?.(copy.saved);
      try {
        await refresh(undefined, version);
      } catch {
        if (current(version)) {
          setView(null);
          setMessage("unavailable");
          shopify.toast?.show?.(copy.unavailable, { isError: true });
        }
      }
    } catch (error) {
      if (current(version) && transport.isNoncommittedError?.(error)) {
        try {
          sessionStorage.removeItem(
            journalKey(operation.input.expectedInstallationGeneration),
          );
          remember(null);
          setConsent(false);
          const consentInput = formRef.current?.elements.namedItem("consent");
          if (consentInput instanceof HTMLInputElement) consentInput.checked = false;
          setMessage("invalid");
          shopify.toast?.show?.(copy.invalid, { isError: true });
          return;
        } catch {
          /* Keep the original attempt when persistence is unavailable. */
        }
      }
      if (current(version)) {
        setView(null);
        setMessage("uncertain");
        shopify.toast?.show?.(copy.uncertain, { isError: true });
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
        shopify.toast?.show?.(copy.unresolved, { isError: true });
        return;
      }
      sessionStorage.removeItem(
        journalKey(operation.input.expectedInstallationGeneration),
      );
      remember(null);
      setMessage("saved");
      shopify.toast?.show?.(copy.saved);
      if (operation.operation === "create") resetForm();
      try {
        await refresh(undefined, version);
      } catch {
        if (current(version)) {
          setView(null);
          setMessage("unavailable");
          shopify.toast?.show?.(copy.unavailable, { isError: true });
        }
      }
    } catch {
      if (current(version)) {
        setView(null);
        setMessage("unresolved");
        shopify.toast?.show?.(copy.unresolved, { isError: true });
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
      shopify.toast?.show?.(copy.unavailable, { isError: true });
    }
  }
  const disabled = busy || !!pending || !view;
  return (
    <section
      className="weletic-flow mx-auto max-w-3xl space-y-4 p-4"
      aria-busy={busy}
      lang={locale}
    >
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h1" variant="headingLg">
            {copy.title}
          </Text>
          <div style={{ width: 140 }}>
            <Select
              label={copy.language}
              labelHidden
              options={[
                { label: "English", value: "en" },
                { label: "日本語", value: "ja" },
                { label: "Tiếng Việt", value: "vi" },
              ]}
              value={locale}
              onChange={(value) =>
                setLocale(value as keyof typeof flowGrantsCopy)
              }
            />
          </div>
        </InlineStack>
        <Text as="p" tone="subdued">
          {copy.intro}
        </Text>
        <p role="status">{copy[message]}</p>
        <InlineStack gap="300">
          {pending && (
            <Button disabled={busy} onClick={() => void reconcile()}>
              {copy.check}
            </Button>
          )}
          <Button
            disabled={busy || !!pending}
            onClick={() => void load()}
          >
            {copy.reload}
          </Button>
        </InlineStack>
        <Card>
          <form
            ref={formRef}
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled || !view) return;
              const form = new FormData(event.currentTarget);
              const formExpires = form.get("expires");
              const rawExpires =
                typeof formExpires === "string" && formExpires
                  ? formExpires
                  : expires;
              const isConsent = form.get("consent") === "on" || consent;
              const isCredit = form.get("credit") === "on" || allowCredit;
              const isDebit = form.get("debit") === "on" || allowDebit;
              const maxVal = (form.get("maximum") as string) || maximum;
              const budgetVal = (form.get("budget") as string) || budget;
              const date = new Date(rawExpires);
              if (
                !Number.isFinite(date.getTime()) ||
                date.getTime() <= Date.now() ||
                !isConsent
              ) {
                setMessage("invalid");
                shopify.toast?.show?.(copy.invalid, { isError: true });
                return;
              }
              const parsed = CreateFlowPointsGrantSchema.safeParse({
                allowCredit: isCredit,
                allowDebit: isDebit,
                maxAbsolutePointsPerAction: maxVal,
                absolutePointsBudget: budgetVal,
                expiresAt: date.toISOString(),
                expectedRevision: 0,
                expectedInstallationGeneration: view.installationGeneration,
              });
              if (!parsed.success) {
                setMessage("invalid");
                shopify.toast?.show?.(copy.invalid, { isError: true });
                return;
              }
              attempt({ operation: "create", input: parsed.data });
            }}
          >
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {copy.create}
              </Text>
              <Checkbox
                name="credit"
                label={copy.credit}
                checked={allowCredit}
                disabled={disabled}
                onChange={(checked) => setAllowCredit(checked)}
              />
              <Checkbox
                name="debit"
                label={copy.debit}
                checked={allowDebit}
                disabled={disabled}
                onChange={(checked) => setAllowDebit(checked)}
              />
              <TextField
                name="maximum"
                label={copy.maximum}
                inputMode="numeric"
                requiredIndicator
                autoComplete="off"
                disabled={disabled}
                value={maximum}
                onChange={(val) => setMaximum(val)}
              />
              <TextField
                name="budget"
                label={copy.budget}
                inputMode="numeric"
                requiredIndicator
                autoComplete="off"
                disabled={disabled}
                value={budget}
                onChange={(val) => setBudget(val)}
              />
              <TextField
                name="expires"
                label={copy.expires}
                type="datetime-local"
                requiredIndicator
                autoComplete="off"
                disabled={disabled}
                value={expires}
                onChange={(val) => setExpires(val)}
              />
              <Checkbox
                name="consent"
                label={copy.consent}
                checked={consent}
                disabled={disabled}
                onChange={(checked) => setConsent(checked)}
              />
              <div>
                <Button submit variant="primary" disabled={disabled}>
                  {copy.create}
                </Button>
              </div>
            </BlockStack>
          </form>
        </Card>
        {view?.grants.length === 0 && <Text as="p">{copy.empty}</Text>}
        {view?.grants.map((grant) => (
          <Card key={grant.id}>
            <BlockStack gap="200">
              <TextField
                label={copy.id}
                readOnly
                autoComplete="off"
                value={grant.id}
              />
              <Text as="p">
                {copy.status}: {copy[grant.status]} · {copy.remaining}:{" "}
                {grant.remainingAbsolutePoints}
              </Text>
              <Text as="p">
                {copy.maximum}: {grant.maxAbsolutePointsPerAction} · {copy.budget}:{" "}
                {grant.absolutePointsBudget}
              </Text>
              <Text as="p">
                {grant.allowCredit ? copy.credit : ""}{" "}
                {grant.allowDebit ? copy.debit : ""}
              </Text>
              <time dateTime={grant.expiresAt}>
                {new Date(grant.expiresAt).toLocaleString(locale)}
              </time>
              {!grant.revokedAt &&
                (confirmation === grant.id ? (
                  <InlineStack gap="200">
                    <Button
                      variant="primary"
                      tone="critical"
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
                    </Button>
                    <Button
                      disabled={disabled}
                      onClick={() => setConfirmation(null)}
                    >
                      {copy.cancel}
                    </Button>
                  </InlineStack>
                ) : (
                  <div>
                    <Button
                      tone="critical"
                      disabled={disabled}
                      onClick={() => setConfirmation(grant.id)}
                    >
                      {copy.revoke}
                    </Button>
                  </div>
                ))}
            </BlockStack>
          </Card>
        ))}
        <InlineStack gap="300">
          <Button disabled={disabled || !cursor} onClick={() => void load()}>
            {copy.first}
          </Button>
          <Button
            disabled={disabled || !view?.nextCursor}
            onClick={() => void load(view?.nextCursor ?? undefined)}
          >
            {copy.next}
          </Button>
        </InlineStack>
      </BlockStack>
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
