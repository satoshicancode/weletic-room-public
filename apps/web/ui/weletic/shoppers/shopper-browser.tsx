"use client";

import React from "react";
import useSWR, { SWRConfig } from "swr";
import type {
  MerchantShopperDirectory,
  MerchantShopperProfile,
} from "../../../lib/weletic/shoppers/merchant-response";
import type { ShopperProfileQuery } from "../../../lib/weletic/shoppers/profile-query";
import {
  emptyShopperSegment,
  hasShopperSegment,
  shopperSegmentSchema,
  type ShopperSegment,
} from "../../../lib/weletic/shoppers/segment-query";
import { shopperCopy, type ShopperCopy, type ShopperLocale } from "./copy";
import { SegmentFields } from "./segment-fields";
import { shopperValue } from "./values";

export type ShopperBrowserTransport = {
  scopeKey: string;
  list: (
    query: {
      search: string;
      cursor: string;
    } & Partial<ShopperSegment>,
  ) => Promise<MerchantShopperDirectory>;
  profile: (query: {
    shopperId: string;
    section: ShopperProfileQuery["section"];
    cursor: string;
  }) => Promise<MerchantShopperProfile>;
};
const button =
  "rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";
const sections = [
  "overview",
  "purchases",
  "points",
  "referrals",
  "reviews",
  "rewards",
  "review_requests",
] as const;
const FreshRead = React.createContext(false);

// SWR can return cached data with isValidating=false before scheduling rAF
// revalidation. Never reuse a cache key across Shopify page/section visits.
// The instance id also separates remounts, including a return to the directory.
function useFreshNavigationKey(query: unknown) {
  const instance = React.useId();
  const serialized = JSON.stringify(query);
  const navigation = React.useRef({ serialized, generation: 0 });
  if (navigation.current.serialized !== serialized) {
    navigation.current = {
      serialized,
      generation: navigation.current.generation + 1,
    };
  }
  return [instance, navigation.current.generation];
}

/** A Shopify screen never shares customer caches with another mounted screen.
 * Every navigation/revalidation must finish a fresh authorized read before
 * cached data is displayed. Tokens and grants are not cached in the browser.
 */
export function ShopperBrowserSession(
  props: React.ComponentProps<typeof ShopperBrowser>,
) {
  const options = React.useMemo(
    () => ({
      provider: () => new Map(),
      shouldRetryOnError: false,
      dedupingInterval: 0,
      revalidateOnMount: true,
    }),
    [],
  );
  return (
    <SWRConfig value={options}>
      <FreshRead.Provider value={true}>
        <ShopperBrowser {...props} />
      </FreshRead.Provider>
    </SWRConfig>
  );
}
const date = (value: string | null, locale: ShopperLocale) =>
  value
    ? `${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value))} UTC`
    : "—";
const points = (value: string, locale: ShopperLocale) =>
  new Intl.NumberFormat(locale).format(BigInt(value));
function money(value: string, currency: string) {
  const digits = new Intl.NumberFormat("en", {
    style: "currency",
    currency,
  }).resolvedOptions().maximumFractionDigits;
  if (digits === undefined) throw new Error("Currency precision unavailable");
  const negative = value.startsWith("-");
  const absolute = (negative ? value.slice(1) : value).padStart(
    digits + 1,
    "0",
  );
  return `${currency} ${negative ? "-" : ""}${digits ? `${absolute.slice(0, -digits)}.${absolute.slice(-digits)}` : absolute}`;
}

export function ShopperBrowser({
  transport,
  shopperId,
  onSelect,
  initialLocale = "en",
}: {
  transport: ShopperBrowserTransport;
  shopperId: string | null;
  onSelect: (id: string | null) => void;
  initialLocale?: ShopperLocale;
}) {
  const [locale, setLocale] = React.useState(initialLocale);
  const text = shopperCopy[locale];
  return (
    <section lang={locale} className="min-w-0 space-y-6 py-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{text.title}</h2>
          <p className="mt-1 text-sm text-neutral-600">{text.subtitle}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          {text.language}
          <select
            className={button}
            value={locale}
            onChange={(event) => setLocale(event.target.value as ShopperLocale)}
          >
            <option value="en">English</option>
            <option value="ja">日本語</option>
            <option value="vi">Tiếng Việt</option>
          </select>
        </label>
      </header>
      {shopperId ? (
        <Profile
          key={`${transport.scopeKey}:${shopperId}`}
          transport={transport}
          shopperId={shopperId}
          locale={locale}
          text={text}
          back={() => onSelect(null)}
        />
      ) : (
        <Directory
          key={transport.scopeKey}
          locale={locale}
          transport={transport}
          text={text}
          onSelect={onSelect}
        />
      )}
    </section>
  );
}

function Failure({ text, retry }: { text: ShopperCopy; retry: () => void }) {
  return (
    <div
      role="alert"
      className="space-y-3 rounded-lg border border-red-200 p-4"
    >
      <p>{text.error}</p>
      <button className={button} onClick={retry}>
        {text.retry}
      </button>
    </div>
  );
}
function Pagination({
  text,
  nextCursor,
  cursor,
  onChange,
}: {
  text: ShopperCopy;
  nextCursor: string | null;
  cursor: string;
  onChange: (cursor: string) => void;
}) {
  return (
    <nav aria-label={text.next} className="flex gap-3">
      <button
        className={button}
        disabled={!cursor}
        onClick={() => onChange("")}
      >
        {text.first}
      </button>
      <button
        className={button}
        disabled={!nextCursor}
        onClick={() => nextCursor && onChange(nextCursor)}
      >
        {text.next}
      </button>
    </nav>
  );
}
function Directory({
  locale,
  transport,
  text,
  onSelect,
}: {
  locale: ShopperLocale;
  transport: ShopperBrowserTransport;
  text: ShopperCopy;
  onSelect: (id: string) => void;
}) {
  const [draft, setDraft] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [cursor, setCursor] = React.useState("");
  const [segmentDraft, setSegmentDraft] = React.useState(emptyShopperSegment);
  const [segment, setSegment] = React.useState(emptyShopperSegment);
  const [invalidSegment, setInvalidSegment] = React.useState(false);
  const navigation = useFreshNavigationKey([
    transport.scopeKey,
    search,
    cursor,
    segment,
  ]);
  const requireFresh = React.useContext(FreshRead);
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    [
      transport.scopeKey,
      "shoppers",
      search,
      cursor,
      segment,
      ...(requireFresh ? navigation : []),
    ],
    () =>
      transport.list({
        search,
        cursor,
        ...(hasShopperSegment(segment) ? segment : {}),
      }),
    { keepPreviousData: false },
  );
  return (
    <div className="space-y-5">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = shopperSegmentSchema.safeParse(segmentDraft);
          setInvalidSegment(!parsed.success);
          if (!parsed.success) return;
          setSegment(parsed.data);
          setSearch(draft.trim());
          setCursor("");
        }}
      >
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          {text.searchHint}
          <input
            className={button}
            value={draft}
            maxLength={100}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <SegmentFields
          locale={locale}
          value={segmentDraft}
          onChange={setSegmentDraft}
          invalid={invalidSegment}
          reset={() => {
            setSegmentDraft(emptyShopperSegment);
            setSegment(emptyShopperSegment);
            setInvalidSegment(false);
            setCursor("");
          }}
        />
        <button className={button} type="submit">
          {text.search}
        </button>
      </form>
      {(isLoading || (requireFresh && isValidating)) && (
        <p role="status">{text.loading}</p>
      )}
      {error && <Failure text={text} retry={() => void mutate()} />}
      {!error && !(requireFresh && isValidating) && data && (
        <>
          <ul className="divide-y rounded-lg border border-neutral-200">
            {data.items.map((shopper) => (
              <li
                key={shopper.id}
                className="flex flex-wrap items-center justify-between gap-3 p-4"
              >
                <div className="min-w-0 break-all">
                  <h3 className="font-medium">
                    {[shopper.firstName, shopper.lastName]
                      .filter(Boolean)
                      .join(" ") ||
                      shopper.email ||
                      shopper.shopifyCustomerId}
                  </h3>
                  <p className="text-sm text-neutral-600">{shopper.email}</p>
                  <p className="text-xs text-neutral-500">
                    {shopper.loyalty ? text.enrolled : text.noAccount}
                  </p>
                </div>
                <button className={button} onClick={() => onSelect(shopper.id)}>
                  {text.open}
                  <span className="sr-only"> {shopper.shopifyCustomerId}</span>
                </button>
              </li>
            ))}
          </ul>
          {data.items.length === 0 && <p>{text.empty}</p>}
          <Pagination
            text={text}
            cursor={cursor}
            nextCursor={data.pagination.nextCursor}
            onChange={setCursor}
          />
        </>
      )}
    </div>
  );
}
function Profile({
  transport,
  shopperId,
  locale,
  text,
  back,
}: {
  transport: ShopperBrowserTransport;
  shopperId: string;
  locale: ShopperLocale;
  text: ShopperCopy;
  back: () => void;
}) {
  const [section, setSection] =
    React.useState<ShopperProfileQuery["section"]>("overview");
  const [cursor, setCursor] = React.useState("");
  const navigation = useFreshNavigationKey([
    transport.scopeKey,
    shopperId,
    section,
    cursor,
  ]);
  const requireFresh = React.useContext(FreshRead);
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    [
      transport.scopeKey,
      "shopper",
      shopperId,
      section,
      cursor,
      ...(requireFresh ? navigation : []),
    ],
    () => transport.profile({ shopperId, section, cursor }),
    { keepPreviousData: false },
  );
  return (
    <div className="space-y-5">
      <button className={button} onClick={back}>
        ← {text.back}
      </button>
      <nav aria-label={text.overview} className="flex flex-wrap gap-2">
        {sections.map((value) => (
          <button
            key={value}
            className={button}
            aria-current={section === value ? "page" : undefined}
            onClick={() => {
              setSection(value);
              setCursor("");
            }}
          >
            {text[value]}
          </button>
        ))}
      </nav>
      {(isLoading || (requireFresh && isValidating)) && (
        <p role="status">{text.loading}</p>
      )}
      {error && <Failure text={text} retry={() => void mutate()} />}
      {!error &&
        !(requireFresh && isValidating) &&
        data &&
        (data.section === "overview" ? (
          <>
            <header>
              <h3 className="break-all text-lg font-semibold">
                {[data.shopper.firstName, data.shopper.lastName]
                  .filter(Boolean)
                  .join(" ") || data.shopper.shopifyCustomerId}
              </h3>
              <p className="text-sm">
                {text.customerId}: {data.shopper.shopifyCustomerId}
              </p>
            </header>
            <dl className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
              <Field label={text.email} value={data.shopper.email ?? "—"} />
              <Field label={text.phone} value={data.shopper.phone ?? "—"} />
              {data.loyalty ? (
                <>
                  <Field
                    label={text.balance}
                    value={points(data.loyalty.pointsBalance, locale)}
                  />
                  <Field
                    label={text.pending}
                    value={points(data.loyalty.pendingPoints, locale)}
                  />
                  <Field
                    label={text.tier}
                    value={data.loyalty.tier?.name ?? "—"}
                  />
                </>
              ) : (
                <Field label={text.loyalty} value={text.noAccount} />
              )}
            </dl>
            <div className="rounded-lg border p-4">
              <h3 className="font-medium">{text.modules}</h3>
              <p>
                {text.loyalty}:{" "}
                {data.modules.loyalty?.killSwitchActive
                  ? text.paused
                  : data.modules.loyalty
                    ? shopperValue(data.modules.loyalty.status, locale)
                    : text.noAccount}
              </p>
              <p>
                {text.reviews}:{" "}
                {data.modules.reviews.enabled ? text.enabled : text.disabled}
              </p>
              <p className="mt-2 text-sm text-neutral-600">{text.historical}</p>
            </div>
            <div className="rounded-lg border p-4">
              <h3 className="font-medium">{text.consent}</h3>
              <p>
                {text.marketing}:{" "}
                {data.communicationPreferences.shopifyAcceptsMarketing
                  ? text.yes
                  : text.no}
              </p>
              <p className="mt-2 text-sm text-neutral-600">
                {text.consentUnknown}
              </p>
            </div>
            <aside className="rounded-lg bg-neutral-50 p-4 text-sm">
              <h3 className="font-medium">{text.coverage}</h3>
              <p>{text.coverageNote}</p>
            </aside>
          </>
        ) : (
          <>
            <History data={data} locale={locale} text={text} />
            {data.pagination && (
              <Pagination
                text={text}
                cursor={cursor}
                nextCursor={data.pagination.nextCursor}
                onChange={setCursor}
              />
            )}
          </>
        ))}
    </div>
  );
}
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="break-all text-sm">{value}</dd>
    </div>
  );
}

function History({
  data,
  text,
  locale,
}: {
  data: Exclude<MerchantShopperProfile, { section: "overview" }>;
  text: ShopperCopy;
  locale: ShopperLocale;
}) {
  type Row = { id: string; fields: [string, string][] };
  let rows: Row[] = [];
  if (data.section === "purchases")
    rows = data.items.map(
      (row): Row => ({
        id: row.id,
        fields: [
          [text.record, row.orderName ?? row.id],
          [text.orderDate, date(row.occurredAt, locale)],
          [text.status, shopperValue(row.status, locale)],
          [text.net, money(row.accountingNet, row.accountingCurrency)],
          [text.total, money(row.accountingTotal, row.accountingCurrency)],
        ],
      }),
    );
  if (data.section === "points")
    rows = data.items.map(
      (row): Row => ({
        id: row.id,
        fields: [
          [text.entryType, shopperValue(row.entryType, locale)],
          [text.date, date(row.createdAt, locale)],
          [text.delta, points(row.pointsDelta, locale)],
          [text.pendingDelta, points(row.pendingDelta, locale)],
          [text.after, points(row.balanceAfter, locale)],
        ],
      }),
    );
  if (data.section === "referrals")
    rows = data.items.map(
      (row): Row => ({
        id: row.id,
        fields: [
          [text.role, shopperValue(row.role, locale)],
          [text.status, shopperValue(row.status, locale)],
          [text.awarded, points(row.pointsAwarded, locale)],
          [text.emailed, date(row.friendRewardEmailedAt, locale)],
        ],
      }),
    );
  if (data.section === "reviews")
    rows = data.items.map(
      (row): Row => ({
        id: row.id,
        fields: [
          [text.titleLabel, row.title],
          [text.rating, `${row.rating}/5`],
          [text.status, shopperValue(row.status, locale)],
          [text.rewardStatus, shopperValue(row.rewardStatus, locale)],
          [text.date, date(row.createdAt, locale)],
        ],
      }),
    );
  if (data.section === "rewards")
    rows = data.items.map(
      (row): Row => ({
        id: row.id,
        fields: [
          [text.record, row.rewardDefinitionId],
          [text.kind, shopperValue(row.artifactKind, locale)],
          [text.status, shopperValue(row.status, locale)],
          [text.cost, points(row.pointsSpent, locale)],
          [text.used, date(row.usedAt, locale)],
          [text.expires, date(row.expiresAt, locale)],
        ],
      }),
    );
  if (data.section === "review_requests")
    rows = data.items.map(
      (row): Row => ({
        id: row.id,
        fields: [
          [text.record, row.productId],
          [text.status, shopperValue(row.status, locale)],
          [text.scheduled, date(row.sendAt, locale)],
          [text.sent, date(row.sentAt, locale)],
          [text.attempts, String(row.deliveryAttempts)],
        ],
      }),
    );
  return (
    <div className="space-y-3">
      {data.section === "purchases" && (
        <p className="text-sm text-neutral-600">{text.originalTotals}</p>
      )}
      {data.section === "review_requests" && (
        <p className="text-sm text-neutral-600">{text.coverageNote}</p>
      )}
      {rows.length === 0 && <p>{text.emptyHistory}</p>}
      {rows.map((row) => (
        <dl
          key={row.id}
          className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {row.fields.map(([label, value]) => (
            <Field key={label} label={label} value={value} />
          ))}
        </dl>
      ))}
    </div>
  );
}
