import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Select,
  Text,
} from "@shopify/polaris";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ShopifyStaffExportPage } from "../../../../apps/web/lib/weletic/shopify/staff-export-contract";
import { StaffAccessClientError } from "../staff-access-client";
import { createStaffExportClient } from "../staff-export-client";

const copy = {
  en: {
    title: "Staff data export",
    kind: "Records",
    grants: "Access grants",
    actions: "Access audit",
    first: "Prepare first page",
    next: "Prepare next page",
    download: "Download this JSON page",
    busy: "Preparing export…",
    page: "Page",
    records: "records",
    more: "More pages remain. Download this page before preparing the next.",
    done: "Last page for this record type.",
    note: "Each page contains up to 100 records and requires current owner authorization. Export both record types for grants and audit history. Historical grants do not imply current access. Grant edits may change between pages; this is not a frozen database snapshot. Keep downloaded files private.",
    error:
      "Export unavailable. Start again from the first page; no automatic retry was made.",
  },
  ja: {
    title: "スタッフデータのエクスポート",
    kind: "レコード",
    grants: "アクセス権限",
    actions: "アクセス監査",
    first: "最初のページを準備",
    next: "次のページを準備",
    download: "このページをJSONで保存",
    busy: "エクスポートを準備中…",
    page: "ページ",
    records: "件",
    more: "続きがあります。次のページを準備する前に、このページを保存してください。",
    done: "この種類の最終ページです。",
    note: "各ページは最大100件で、毎回現在のオーナー認証が必要です。権限と監査履歴の両方を保存するには、両方の種類をエクスポートしてください。過去の権限は現在のアクセスを意味しません。ページ間で権限が変更される場合があり、固定されたデータベースのスナップショットではありません。保存したファイルは非公開で管理してください。",
    error:
      "エクスポートできません。最初のページからやり直してください。自動再試行はしていません。",
  },
  vi: {
    title: "Xuất dữ liệu nhân viên",
    kind: "Loại bản ghi",
    grants: "Quyền truy cập",
    actions: "Nhật ký truy cập",
    first: "Chuẩn bị trang đầu",
    next: "Chuẩn bị trang tiếp",
    download: "Tải trang JSON này",
    busy: "Đang chuẩn bị dữ liệu…",
    page: "Trang",
    records: "bản ghi",
    more: "Còn trang tiếp theo. Hãy tải trang này trước khi chuẩn bị trang tiếp.",
    done: "Đây là trang cuối của loại bản ghi này.",
    note: "Mỗi trang có tối đa 100 bản ghi và yêu cầu xác thực chủ tài khoản hiện tại. Xuất cả hai loại để lấy quyền truy cập và nhật ký. Quyền trong quá khứ không có nghĩa là quyền hiện tại. Quyền có thể thay đổi giữa các trang; đây không phải ảnh chụp cố định của database. Giữ các tệp tải xuống riêng tư.",
    error:
      "Không thể xuất dữ liệu. Hãy bắt đầu lại từ trang đầu; hệ thống không tự động thử lại.",
  },
};

export function StaffExport({
  locale,
  disabled,
  onDenied,
}: {
  locale: "en" | "ja" | "vi";
  disabled: boolean;
  onDenied: (error: StaffAccessClientError) => void;
}) {
  const shopify = useAppBridge();
  const read = useMemo(
    () => createStaffExportClient(() => shopify.idToken()),
    [shopify],
  );
  const text = copy[locale];
  const [kind, setKind] = useState<"grants" | "actions">("grants");
  const [prepared, setPrepared] = useState<{
    data: ShopifyStaffExportPage;
    page: number;
  } | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (error) notice.current?.focus();
  }, [error]);
  useEffect(() => {
    setUrl(null);
    if (!prepared) return;
    try {
      const objectUrl = URL.createObjectURL(
        new Blob(
          [JSON.stringify({ page: prepared.page, ...prepared.data }, null, 2)],
          { type: "application/json" },
        ),
      );
      setUrl(objectUrl);
      return () => URL.revokeObjectURL(objectUrl);
    } catch {
      setPrepared(null);
      setError(true);
    }
  }, [prepared]);
  async function prepare(previous?: NonNullable<typeof prepared>) {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    setPrepared(null);
    setUrl(null);
    try {
      const data = await read(
        {
          kind,
          limit: 100,
          ...(previous?.data.nextCursor
            ? { cursor: previous.data.nextCursor }
            : {}),
        },
        previous?.data,
      );
      if (mounted.current)
        setPrepared({ data, page: previous ? previous.page + 1 : 1 });
    } catch (failure) {
      if (mounted.current) {
        if (
          failure instanceof StaffAccessClientError &&
          (failure.code === "denied" || failure.code === "reauthenticate")
        )
          onDenied(failure);
        else setError(true);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {text.title}
        </Text>
        <Text as="p">{text.note}</Text>
        <Select
          label={text.kind}
          value={kind}
          disabled={disabled || busy}
          options={[
            { label: text.grants, value: "grants" },
            { label: text.actions, value: "actions" },
          ]}
          onChange={(value) => {
            if (value === "grants" || value === "actions") {
              setKind(value);
              setPrepared(null);
              setUrl(null);
              setError(false);
            }
          }}
        />
        {error && (
          <div tabIndex={-1} ref={notice}>
            <Banner tone="critical">
              <p>{text.error}</p>
            </Banner>
          </div>
        )}
        {busy && <p role="status">{text.busy}</p>}
        <InlineStack gap="200">
          <Button disabled={disabled || busy} onClick={() => void prepare()}>
            {text.first}
          </Button>
          {prepared?.data.nextCursor && (
            <Button
              disabled={disabled || busy}
              onClick={() => void prepare(prepared)}
            >
              {text.next}
            </Button>
          )}
        </InlineStack>
        {prepared && (
          <BlockStack gap="100">
            <p role="status">
              {text.page} {prepared.page} · {prepared.data.rows.length}{" "}
              {text.records}
            </p>
            <Text as="p">
              {prepared.data.nextCursor ? text.more : text.done}
            </Text>
            {url && !disabled && (
              <a
                href={url}
                download={`weletic-staff-${prepared.data.kind}-page-${prepared.page}.json`}
              >
                {text.download}
              </a>
            )}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
