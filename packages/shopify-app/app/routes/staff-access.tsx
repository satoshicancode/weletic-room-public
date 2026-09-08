import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SHOPIFY_STAFF_PERMISSIONS,
  type ShopifyStaffGrantView,
  type ShopifyStaffPermission,
} from "../../../../apps/web/lib/weletic/shopify/staff-contract";
import { StaffExport } from "../components/StaffExport";
import {
  createStaffAccessClient,
  StaffAccessClientError,
} from "../staff-access-client";
import { staffAccessCopy } from "../staff-access-copy";

// The page shell contains no merchant data. All reads and writes below require
// a fresh bearer token and owner authorization at the backend transaction.
export default function StaffAccessPage() {
  const shopify = useAppBridge();
  const client = useMemo(
    () => createStaffAccessClient(() => shopify.idToken()),
    [shopify],
  );
  const [locale, setLocale] = useState<"en" | "ja" | "vi">("en");
  const copy = staffAccessCopy[locale];
  const [grants, setGrants] = useState<ShopifyStaffGrantView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(true);
  const [error, setError] = useState<StaffAccessClientError["code"] | null>(
    null,
  );
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState<ShopifyStaffGrantView | null>(null);
  const [userId, setUserId] = useState("");
  const [permissions, setPermissions] = useState<ShopifyStaffPermission[]>([]);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const errorNotice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorNotice.current?.focus();
  }, [error]);
  const resetEditor = () => {
    setEditing(null);
    setUserId("");
    setPermissions([]);
  };
  const fail = useCallback((failure: unknown) => {
    if (!mounted.current) return;
    const code =
      failure instanceof StaffAccessClientError ? failure.code : "unavailable";
    setError(code);
    setReloadRequired(true);
    setSaved(false);
    if (code === "denied" || code === "reauthenticate") {
      setGrants([]);
      setLoaded(false);
      setNextCursor(null);
      setEditing(null);
      setUserId("");
      setPermissions([]);
    }
  }, []);
  const load = useCallback(
    async (cursor?: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      setSaved(false);
      try {
        const page = await client.list(cursor ? { cursor } : {});
        if (!mounted.current) return;
        setGrants(page.grants);
        setNextCursor(page.nextCursor);
        setLoaded(true);
        setReloadRequired(false);
        setEditing(null);
        setUserId("");
        setPermissions([]);
      } catch (failure) {
        fail(failure);
      } finally {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [client, fail],
  );
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);
  const disabled = busy || !loaded || reloadRequired;
  async function save() {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setSaved(false);
    setReloadRequired(true);
    try {
      await client.save({
        userId,
        permissions,
        expectedRevision: editing?.revision ?? 0,
      });
      const page = await client.list();
      if (!mounted.current) return;
      setGrants(page.grants);
      setNextCursor(page.nextCursor);
      setReloadRequired(false);
      setSaved(true);
      resetEditor();
    } catch (failure) {
      fail(failure);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div lang={locale}>
      <Page title={copy.title}>
        <BlockStack gap="400">
          <Select
            label={copy.language}
            value={locale}
            options={[
              { label: "English", value: "en" },
              { label: "日本語", value: "ja" },
              { label: "Tiếng Việt", value: "vi" },
            ]}
            onChange={(value) => {
              if (value === "en" || value === "ja" || value === "vi")
                setLocale(value);
            }}
          />
          <Text as="p">{copy.description}</Text>
          {loaded && (
            <StaffExport locale={locale} disabled={disabled} onDenied={fail} />
          )}
          {error && (
            <div ref={errorNotice} tabIndex={-1}>
              <Banner tone="critical">
                <p>{copy.errors[error]}</p>
              </Banner>
            </div>
          )}
          {saved && (
            <Banner tone="success">
              <p role="status">{copy.saved}</p>
            </Banner>
          )}
          <InlineStack gap="200">
            <Button disabled={busy} onClick={() => void load()}>
              {copy.refresh}
            </Button>
            <Button disabled={disabled} onClick={resetEditor}>
              {copy.newGrant}
            </Button>
          </InlineStack>
          {busy && <p role="status">{copy.loading}</p>}
          {loaded && (
            <Card>
              <BlockStack gap="300">
                {!grants.length && <Text as="p">{copy.empty}</Text>}
                {grants.map((grant) => (
                  <BlockStack key={grant.userId} gap="100">
                    <InlineStack gap="200" align="space-between">
                      <Text as="h2" variant="headingSm">
                        {copy.userId}: {grant.userId}
                      </Text>
                      <Button
                        disabled={disabled || grant.status === "invalid"}
                        onClick={() => {
                          setEditing(grant);
                          setUserId(grant.userId);
                          setPermissions([...grant.permissions]);
                          setSaved(false);
                        }}
                      >
                        {copy.edit}
                      </Button>
                    </InlineStack>
                    <Text as="p">
                      {copy.status[grant.status]} · {copy.revision}{" "}
                      {grant.revision}
                    </Text>
                    <Text as="p">
                      {grant.permissions
                        .map((permission) => copy.labels[permission])
                        .join(", ")}
                    </Text>
                  </BlockStack>
                ))}
                {nextCursor && (
                  <Button
                    disabled={disabled}
                    onClick={() => void load(nextCursor)}
                  >
                    {copy.next}
                  </Button>
                )}
              </BlockStack>
            </Card>
          )}
          {loaded && (
            <Card>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <BlockStack gap="300">
                  <TextField
                    label={copy.userId}
                    helpText={copy.idHelp}
                    value={userId}
                    onChange={setUserId}
                    autoComplete="off"
                    disabled={disabled || editing !== null}
                  />
                  <fieldset disabled={disabled}>
                    <legend>{copy.permissions}</legend>
                    <BlockStack gap="100">
                      {SHOPIFY_STAFF_PERMISSIONS.map((permission) => (
                        <Checkbox
                          key={permission}
                          label={copy.labels[permission]}
                          checked={permissions.includes(permission)}
                          onChange={(checked) =>
                            setPermissions((current) =>
                              checked
                                ? [
                                    ...current.filter((p) => p !== permission),
                                    permission,
                                  ]
                                : current.filter((p) => p !== permission),
                            )
                          }
                        />
                      ))}
                    </BlockStack>
                  </fieldset>
                  <Text as="p">{copy.note}</Text>
                  <InlineStack gap="200">
                    <Button
                      submit
                      variant="primary"
                      disabled={disabled || !userId}
                    >
                      {editing && !permissions.length ? copy.revoke : copy.save}
                    </Button>
                    <Button
                      disabled={disabled}
                      onClick={() => setPermissions([])}
                    >
                      {copy.clear}
                    </Button>
                    {editing && (
                      <Button disabled={busy} onClick={resetEditor}>
                        {copy.cancel}
                      </Button>
                    )}
                  </InlineStack>
                </BlockStack>
              </form>
            </Card>
          )}
        </BlockStack>
      </Page>
    </div>
  );
}
