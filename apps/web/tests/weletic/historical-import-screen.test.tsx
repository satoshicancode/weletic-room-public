// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImportsScreen } from "../../../../packages/shopify-app/app/imports-screen";
const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("../../../../packages/shopify-app/app/merchant-import-file", () => ({
  prepareMerchantImportFile: mocks.prepare,
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const source = { sha256: "a".repeat(64), format: "csv" as const };
const preview = {
  storeId: "private-store",
  installationGeneration: "generation",
  revision: "b".repeat(64),
  rowCount: 1,
  totalOpeningBalance: "10",
  source,
  valid: true,
  rows: [
    {
      rowNumber: 1,
      issues: [],
      wouldEnroll: false,
      balanceBefore: "0",
      balanceAfter: "10",
    },
  ],
};
let node: HTMLDivElement;
let root: Root;
beforeEach(() => {
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  mocks.prepare
    .mockReset()
    .mockResolvedValue({ source, sourceBase64: "private-file-content" });
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});
const button = (text: string) =>
  [...node.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  )!;
async function render(
  request: ComponentProps<typeof ImportsScreen>["request"],
  configure = true,
  readStatus: ComponentProps<typeof ImportsScreen>["readStatus"] = vi.fn(),
  readHistory: ComponentProps<typeof ImportsScreen>["readHistory"] = vi.fn(),
) {
  await act(async () =>
    root.render(
      createElement(ImportsScreen, {
        generation: "generation",
        configure,
        request,
        readStatus,
        readHistory,
        reconcile: vi.fn(),
        execute: vi.fn(),
      }),
    ),
  );
}
async function file() {
  const input = node.querySelector('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["private-customer"], "private-name.csv")],
  });
  await act(async () =>
    input.dispatchEvent(new Event("change", { bubbles: true })),
  );
}
it("previews and stages without exposing file/customer/scope identifiers", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(preview)
    .mockResolvedValueOnce({
      ...preview,
      status: "preview",
      sourceId: "private-source",
    });
  await render(request);
  await file();
  expect(button("Stage validated file").disabled).toBe(true);
  await act(async () => button("Preview file").click());
  expect(node.textContent).toContain("Opening points: 10");
  const region = node.querySelector<HTMLElement>('[role="region"]')!;
  expect(region.getAttribute("aria-label")).toBe("Preview file");
  expect(region.tabIndex).toBe(0);
  expect(region.style.overflowX).toBe("auto");
  expect(region.querySelector("table")!.style.whiteSpace).toBe("nowrap");
  expect(node.innerHTML).not.toMatch(/private-|generation/);
  await act(async () => button("Stage validated file").click());
  expect(request.mock.calls[1][0].request).toMatchObject({
    operation: "stage",
    expectedRevision: preview.revision,
    expectedInstallationGeneration: "generation",
  });
  expect(node.textContent).toContain("No points were committed");
  expect(button("Stage validated file").disabled).toBe(true);
});
it("connects a staged source to status and removes it when permission is lost", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(preview)
    .mockResolvedValueOnce({
      ...preview,
      status: "preview",
      sourceId: "private-source",
    });
  const readStatus = vi
    .fn()
    .mockRejectedValue(new Error("private permission failure"));
  await render(request, true, readStatus);
  await file();
  await act(async () => button("Preview file").click());
  await act(async () => button("Stage validated file").click());
  await act(async () => button("Refresh import status").click());
  expect(readStatus).toHaveBeenCalledWith({
    operation: "status",
    sourceId: "private-source",
    expectedInstallationGeneration: "generation",
  });
  expect(node.innerHTML).not.toContain("private");
  await render(request, false, readStatus);
  expect(button("Refresh import status")).toBeUndefined();
  expect(button("Load latest imports")).toBeUndefined();
  expect(readStatus).toHaveBeenCalledTimes(1);
});
it("loads history without selecting a file or triggering a preparation write", async () => {
  const request = vi.fn();
  const readHistory = vi.fn().mockRejectedValue(new Error("private denial"));
  await render(request, true, vi.fn(), readHistory);
  await act(async () => button("Load latest imports").click());
  expect(readHistory).toHaveBeenCalledWith({
    operation: "history",
    expectedInstallationGeneration: "generation",
  });
  expect(request).not.toHaveBeenCalled();
  expect(node.textContent).not.toContain("private denial");
});
it("discards the previous preview when a new file is selected", async () => {
  const request = vi.fn().mockResolvedValue(preview);
  await render(request);
  await file();
  await act(async () => button("Preview file").click());
  await file();
  expect(button("Stage validated file").disabled).toBe(true);
  expect(node.querySelector("table")).toBeNull();
});
it.each([
  ["en", "Birthday conflicts with the existing registration"],
  ["ja", "誕生日が既存の登録と一致しません"],
  ["vi", "Ngày sinh không khớp với thông tin đã đăng ký"],
])(
  "shows a private birthday conflict in %s and prevents staging",
  async (locale, message) => {
    const request = vi.fn().mockResolvedValue({
      ...preview,
      valid: false,
      rows: [
        {
          rowNumber: 1,
          issues: ["birthday_conflict"],
          wouldEnroll: false,
          balanceBefore: null,
          balanceAfter: null,
        },
      ],
    });
    await render(request);
    await file();
    const stage = button("Stage validated file");
    await act(async () => button("Preview file").click());
    const select = node.querySelector("select")!;
    await act(async () => {
      select.value = locale;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(node.textContent).toContain(message);
    expect(stage.disabled).toBe(true);
    await act(async () => stage.click());
    expect(request).toHaveBeenCalledTimes(1);
    expect(node.innerHTML).not.toMatch(/private-|registeredAt|birthDate/);
  },
);
it("clears the retry path after an uncertain staging result", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(preview)
    .mockRejectedValueOnce(new Error("private backend details"));
  await render(request);
  await file();
  await act(async () => button("Preview file").click());
  await act(async () => button("Stage validated file").click());
  expect(node.textContent).toContain("No automatic retry");
  expect(node.textContent).not.toContain("private backend");
  expect(button("Stage validated file").disabled).toBe(true);
  expect(button("Preview file").disabled).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
});
it("disables upload without configure permission", async () => {
  const request = vi.fn();
  await render(request, false);
  expect(
    (node.querySelector('input[type="file"]') as HTMLInputElement).disabled,
  ).toBe(true);
  expect(node.textContent).toContain("permission is required");
  expect(request).not.toHaveBeenCalled();
});
it("suppresses duplicate dispatch and ignores a result after unmount", async () => {
  let resolve!: (value: typeof preview) => void;
  const request = vi.fn().mockReturnValue(
    new Promise<typeof preview>((done) => {
      resolve = done;
    }),
  );
  await render(request);
  await file();
  await act(async () => {
    button("Preview file").click();
    button("Preview file").click();
  });
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () =>
    root.render(createElement("p", null, "New store context")),
  );
  await act(async () => resolve(preview));
  expect(node.textContent).toBe("New store context");
  expect(node.querySelector("table")).toBeNull();
});
it.each([
  ["ja", "ロイヤルティ開始残高"],
  ["vi", "Nhập số dư loyalty"],
])("renders %s controls", async (locale, text) => {
  await render(vi.fn());
  const select = node.querySelector("select")!;
  await act(async () => {
    select.value = locale;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(node.textContent).toContain(text);
  expect(node.querySelector("section")?.lang).toBe(locale);
});
