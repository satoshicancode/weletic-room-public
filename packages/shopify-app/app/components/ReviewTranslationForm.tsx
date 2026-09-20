import { BlockStack, Button, Select, Text, TextField } from "@shopify/polaris";
import { useEffect, useRef, useState } from "react";
import {
  manualReviewLocaleSchema,
  manualReviewTranslationInputSchema,
  type ManualReviewTranslationInput,
  type ManualReviewTranslationPage,
} from "../../../../apps/web/lib/weletic/reviews/translation-contract";
import { reviewTranslationCopy } from "../review-translation-copy";

type Props = {
  page: ManualReviewTranslationPage;
  locale: keyof typeof reviewTranslationCopy;
  disabled: boolean;
  save: (input: ManualReviewTranslationInput) => Promise<void>;
  reload: () => Promise<void>;
  /** Change only after a fresh authorized read, not as a mutation retry. */
  snapshotKey: string;
  onDirtyChange?: (dirty: boolean) => void;
};

export function ReviewTranslationForm(props: Props) {
  return (
    <TranslationSnapshotForm
      {...props}
      key={JSON.stringify([
        props.snapshotKey,
        props.page.reviewId,
        props.page.installationGeneration,
        props.page.reviewVersion,
        props.page.translations,
      ])}
    />
  );
}

function TranslationSnapshotForm({
  page,
  locale,
  disabled,
  save,
  reload,
  onDirtyChange,
}: Props) {
  const copy = reviewTranslationCopy[locale];
  const [target, setTarget] = useState<"en" | "ja" | "vi">("en");
  const initial = page.translations.find((row) => row.locale === "en");
  const [source, setSource] = useState(initial?.sourceLocale ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const drafts = useRef<
    Partial<
      Record<
        "en" | "ja" | "vi",
        { source: string; title: string; body: string }
      >
    >
  >({});
  const [state, setState] = useState<
    "idle" | "invalid" | "saving" | "saved" | "uncertain"
  >("idle");
  const submitted = useRef(false);
  const savePending = useRef(false);
  const reloadPending = useRef(false);
  const [reloading, setReloading] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const row = page.translations.find((item) => item.locale === target);
  const dirty = Object.entries({
    ...drafts.current,
    [target]: { source, title, body },
  }).some(([language, draft]) => {
    // Saving the locked current locale does not persist other locale drafts.
    if (state === "saved" && language === target) return false;
    const saved = page.translations.find((item) => item.locale === language);
    return (
      draft.source !== (saved?.sourceLocale ?? "") ||
      draft.title !== (saved?.title ?? "") ||
      draft.body !== (saved?.body ?? "")
    );
  });
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const locked =
    disabled ||
    reloading ||
    submitted.current ||
    row?.status === "redacted" ||
    page.reviewVersion >= 2147483647 ||
    (row?.revision ?? 0) >= 2147483647;
  const changeTarget = (value: string) => {
    if (disabled || submitted.current || reloadPending.current) return;
    const next = manualReviewLocaleSchema.parse(value);
    drafts.current[target] = { source, title, body };
    const saved = page.translations.find((item) => item.locale === next);
    const draft = drafts.current[next];
    setTarget(next);
    setSource(draft?.source ?? saved?.sourceLocale ?? "");
    setTitle(draft?.title ?? saved?.title ?? "");
    setBody(draft?.body ?? saved?.body ?? "");
    setState("idle");
  };
  const submit = async (action: "save" | "remove") => {
    if (locked || submitted.current || reloadPending.current) return;
    const parsed = manualReviewTranslationInputSchema.safeParse({
      action,
      reviewId: page.reviewId,
      locale: target,
      expectedInstallationGeneration: page.installationGeneration,
      expectedReviewVersion: page.reviewVersion,
      expectedTranslationRevision: row?.revision ?? 0,
      ...(action === "save"
        ? { title, body, sourceLocale: source || null }
        : {}),
    });
    if (!parsed.success) {
      setState("invalid");
      return;
    }
    submitted.current = true;
    savePending.current = true;
    setState("saving");
    try {
      await save(parsed.data);
      setState("saved");
    } catch {
      setState("uncertain");
    } finally {
      savePending.current = false;
    }
  };
  const reloadSnapshot = async (discard: boolean) => {
    if (disabled || savePending.current || reloadPending.current) return;
    const changed = Object.entries({
      ...drafts.current,
      [target]: { source, title, body },
    }).some(([language, draft]) => {
      const saved = page.translations.find((item) => item.locale === language);
      return (
        draft.source !== (saved?.sourceLocale ?? "") ||
        draft.title !== (saved?.title ?? "") ||
        draft.body !== (saved?.body ?? "")
      );
    });
    if (changed && !discard) {
      setConfirmDiscard(true);
      return;
    }
    reloadPending.current = true;
    setReloading(true);
    setReloadFailed(false);
    try {
      await reload();
      setConfirmDiscard(false);
    } catch {
      setReloadFailed(true);
    } finally {
      reloadPending.current = false;
      setReloading(false);
    }
  };
  const options = [
    { label: "English", value: "en" },
    { label: "日本語", value: "ja" },
    { label: "Tiếng Việt", value: "vi" },
  ];
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit("save");
      }}
    >
      <BlockStack gap="200">
        <Text as="h3" variant="headingSm">
          {copy.heading}
        </Text>
        <Text as="p">{copy.help}</Text>
        <Text as="h4" variant="headingSm">
          {copy.original}
        </Text>
        <Text as="p" breakWord>
          {page.original.title}
        </Text>
        <Text as="p" breakWord>
          {page.original.body}
        </Text>
        <Select
          label={copy.target}
          options={options}
          value={target}
          onChange={changeTarget}
          disabled={disabled || submitted.current || reloading}
        />
        {row?.status === "stale" && <p role="status">{copy.stale}</p>}
        {row?.status === "redacted" && <p role="status">{copy.redacted}</p>}
        <Select
          label={copy.source}
          options={[{ label: copy.unknown, value: "" }, ...options]}
          value={source}
          onChange={setSource}
          disabled={locked}
        />
        <TextField
          label={copy.title}
          value={title}
          onChange={setTitle}
          maxLength={120}
          autoComplete="off"
          disabled={locked}
        />
        <TextField
          label={copy.body}
          value={body}
          onChange={setBody}
          maxLength={10000}
          multiline={5}
          autoComplete="off"
          disabled={locked}
        />
        {state !== "idle" && (
          <p
            role={
              state === "invalid" || state === "uncertain" ? "alert" : "status"
            }
          >
            {copy[state]}
          </p>
        )}
        <Button submit disabled={locked}>
          {copy.save}
        </Button>
        <Button
          tone="critical"
          disabled={locked || !row || row.status === "removed"}
          onClick={() => {
            void submit("remove");
          }}
        >
          {copy.remove}
        </Button>
        {confirmDiscard && (
          <div role="group" aria-label={copy.discardWarning}>
            <p role="alert">{copy.discardWarning}</p>
            <Button
              disabled={disabled || reloading || state === "saving"}
              onClick={() => {
                void reloadSnapshot(true);
              }}
            >
              {copy.discardReload}
            </Button>
            <Button
              disabled={reloading}
              onClick={() => setConfirmDiscard(false)}
            >
              {copy.keepDrafts}
            </Button>
          </div>
        )}
        {reloadFailed && <p role="alert">{copy.reloadFailed}</p>}
        <Button
          disabled={disabled || reloading || state === "saving"}
          onClick={() => {
            void reloadSnapshot(false);
          }}
        >
          {copy.reload}
        </Button>
      </BlockStack>
    </form>
  );
}
