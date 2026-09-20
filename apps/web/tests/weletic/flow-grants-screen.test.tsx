// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  FlowGrantListResponse,
  FlowGrantView,
} from "../../lib/weletic/loyalty/flow-grants-merchant-contract";
import {
  FlowGrantsSession,
  type FlowGrantsTransport,
} from "../../ui/weletic/loyalty/flow-grants-screen";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const nonce = "a".repeat(64);
const grant: FlowGrantView = {
  id: `wflowgrant_${"x".repeat(20)}`,
  revision: 1,
  allowCredit: true,
  allowDebit: false,
  maxAbsolutePointsPerAction: "9007199254740993",
  absolutePointsBudget: "18446744073709551615",
  absolutePointsUsed: "0",
  remainingAbsolutePoints: "18446744073709551615",
  createdAt: "2026-09-20T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  revokedAt: null,
  status: "active",
};
const view: FlowGrantListResponse = {
  grants: [],
  nextCursor: null,
  installationGeneration: "g1",
  observedAt: "2026-09-20T00:00:00.000Z",
};
let root: Root, container: HTMLDivElement, transport: FlowGrantsTransport;
beforeEach(() => {
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  transport = {
    scopeKey: "store-a",
    newAttemptId: () => nonce,
    list: vi.fn().mockResolvedValue(view),
    write: vi
      .fn()
      .mockResolvedValue({ id: grant.id, revision: 1, revokedAt: null }),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render() {
  await act(async () =>
    root.render(createElement(FlowGrantsSession, { transport })),
  );
}
function button(text: string) {
  const result = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === text,
  );
  if (!result) throw new Error(text);
  return result;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
function fill() {
  for (const [name, value] of Object.entries({
    maximum: grant.maxAbsolutePointsPerAction,
    budget: grant.absolutePointsBudget,
    expires: "2099-01-01T00:00",
  }))
    (container.querySelector(`[name=${name}]`) as HTMLInputElement).value =
      value;
  for (const name of ["credit", "consent"])
    (container.querySelector(`[name=${name}]`) as HTMLInputElement).checked =
      true;
}
async function submit(twice = false) {
  await act(async () => {
    const form = container.querySelector("form")!;
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    if (twice)
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
  });
}
it("fails closed when owner access is denied", async () => {
  vi.mocked(transport.list).mockRejectedValue(new Error("denied"));
  await render();
  expect(container.querySelector("fieldset")!.disabled).toBe(true);
  expect(container.textContent).toContain("Access or data unavailable");
  expect(transport.write).not.toHaveBeenCalled();
});
it("requires explicit direction and consent", async () => {
  await render();
  await submit();
  expect(transport.write).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Select a direction");
});
it("preserves exact limits, prevents duplicate dispatch and resets consent", async () => {
  await render();
  fill();
  await submit(true);
  expect(transport.write).toHaveBeenCalledTimes(1);
  expect(transport.write).toHaveBeenCalledWith(
    expect.objectContaining({
      attemptId: nonce,
      input: expect.objectContaining({
        maxAbsolutePointsPerAction: "9007199254740993",
        absolutePointsBudget: "18446744073709551615",
        expectedInstallationGeneration: "g1",
      }),
    }),
  );
  expect(
    (container.querySelector("[name=consent]") as HTMLInputElement).checked,
  ).toBe(false);
  expect(container.innerHTML).not.toContain(nonce);
});
it("does not retry an ambiguous create or unlock after empty recovery", async () => {
  vi.mocked(transport.write).mockRejectedValue(new Error("lost"));
  await render();
  fill();
  await submit();
  expect(button("Refresh").disabled).toBe(true);
  await click("Check original attempt");
  expect(transport.list).toHaveBeenLastCalledWith({
    approvalRequestId: nonce,
    expectedInstallationGeneration: "g1",
  });
  expect(container.querySelector("fieldset")!.disabled).toBe(true);
  expect(container.textContent).toContain("No conclusive result");
  await submit();
  expect(transport.write).toHaveBeenCalledTimes(1);
  const request = vi.mocked(transport.write).mock.calls[0][0] as {
    input: { expiresAt: string };
  };
  vi.mocked(transport.list).mockResolvedValueOnce({
    ...view,
    grants: [{ ...grant, expiresAt: request.input.expiresAt }],
  });
  await click("Check original attempt");
  expect(container.querySelector("fieldset")!.disabled).toBe(false);
  expect(container.innerHTML).not.toContain(nonce);
});
it("keeps a mismatched create recovery locked", async () => {
  vi.mocked(transport.write).mockRejectedValue(new Error("lost"));
  await render();
  fill();
  await submit();
  vi.mocked(transport.list).mockResolvedValue({
    ...view,
    grants: [{ ...grant, allowDebit: true }],
  });
  await click("Check original attempt");
  expect(container.querySelector("fieldset")!.disabled).toBe(true);
});
it("requires revocation confirmation and excludes UI cursor from the request", async () => {
  vi.mocked(transport.list).mockResolvedValue({ ...view, grants: [grant] });
  await render();
  await click("Revoke");
  expect(transport.write).not.toHaveBeenCalled();
  await click("Confirm revocation");
  expect(transport.write).toHaveBeenCalledWith({
    operation: "revoke",
    attemptId: nonce,
    input: {
      grantId: grant.id,
      expectedRevision: 1,
      expectedInstallationGeneration: "g1",
    },
  });
});
it("reports failed post-confirmation refresh as unavailable, not uncertain", async () => {
  vi.mocked(transport.write).mockRejectedValue(new Error("lost"));
  await render();
  fill();
  await submit();
  const request = vi.mocked(transport.write).mock.calls[0][0] as {
    input: { expiresAt: string };
  };
  vi.mocked(transport.list)
    .mockResolvedValueOnce({
      ...view,
      grants: [{ ...grant, expiresAt: request.input.expiresAt }],
    })
    .mockRejectedValueOnce(new Error("offline"));
  await click("Check original attempt");
  expect(container.textContent).toContain("Access or data unavailable");
  expect(container.textContent).not.toContain("Check original attempt");
  expect(container.querySelector("fieldset")!.disabled).toBe(true);
});
it.each([
  ["ja", "Shopify Flowのポイント権限"],
  ["vi", "Quyền điều chỉnh điểm qua Shopify Flow"],
])("renders %s controls", async (locale, title) => {
  await render();
  await act(async () => {
    const select = container.querySelector("select")!;
    select.value = locale;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain(title);
});
it("ignores the first stale StrictMode bootstrap response", async () => {
  let finish!: (data: FlowGrantListResponse) => void;
  vi.mocked(transport.list)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(view);
  await act(async () =>
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(FlowGrantsSession, { transport }),
      ),
    ),
  );
  await act(async () => finish({ ...view, grants: [grant] }));
  expect(container.textContent).toContain("No grants on this page");
});
it("restores a pending attempt after navigation without replaying it", async () => {
  vi.mocked(transport.write).mockRejectedValue(new Error("lost"));
  await render();
  fill();
  await submit();
  transport = { ...transport, scopeKey: "remounted-route" };
  await render();
  expect(container.querySelector("fieldset")!.disabled).toBe(true);
  await click("Check original attempt");
  expect(transport.list).toHaveBeenLastCalledWith({
    expectedInstallationGeneration: "g1",
    approvalRequestId: nonce,
  });
  expect(transport.write).toHaveBeenCalledTimes(1);
});
it("uses exact grant recovery after an ambiguous revocation", async () => {
  vi.mocked(transport.list).mockResolvedValue({ ...view, grants: [grant] });
  vi.mocked(transport.write).mockRejectedValue(new Error("lost"));
  await render();
  await click("Revoke");
  await click("Confirm revocation");
  vi.mocked(transport.list).mockResolvedValueOnce({
    ...view,
    grants: [
      { ...grant, revision: 2, revokedAt: view.observedAt, status: "revoked" },
    ],
  });
  await click("Check original attempt");
  expect(transport.list).toHaveBeenNthCalledWith(2, {
    expectedInstallationGeneration: "g1",
    grantId: grant.id,
  });
  expect(container.querySelector("fieldset")!.disabled).toBe(false);
});
it("resets authorization intent when a replacement client loads another generation", async () => {
  await render();
  fill();
  transport = {
    ...transport,
    list: vi.fn().mockResolvedValue({ ...view, installationGeneration: "g2" }),
  };
  await render();
  expect(
    (container.querySelector("[name=consent]") as HTMLInputElement).checked,
  ).toBe(false);
  expect(
    (container.querySelector("[name=maximum]") as HTMLInputElement).value,
  ).toBe("");
  await submit();
  expect(transport.write).not.toHaveBeenCalled();
});
it("does not dispatch when recovery persistence is unavailable", async () => {
  await render();
  fill();
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  try {
    await submit();
    expect(transport.write).not.toHaveBeenCalled();
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
it("allows explicit correction after a proven noncommitted validation rejection", async () => {
  const invalid = new Error("invalid expiry");
  transport.isNoncommittedError = (error) => error === invalid;
  vi.mocked(transport.write).mockRejectedValueOnce(invalid);
  await render();
  fill();
  await submit();
  expect(container.querySelector("fieldset")!.disabled).toBe(false);
  expect(
    (container.querySelector("[name=consent]") as HTMLInputElement).checked,
  ).toBe(false);
  expect(sessionStorage.length).toBe(0);
  expect(transport.write).toHaveBeenCalledTimes(1);
  fill();
  await submit();
  expect(transport.write).toHaveBeenCalledTimes(2);
});
it("clears old consent when a second refresh bootstraps a new generation", async () => {
  await render();
  fill();
  vi.mocked(transport.list).mockRejectedValueOnce(
    new Error("generation changed"),
  );
  await click("Refresh");
  vi.mocked(transport.list).mockResolvedValueOnce({
    ...view,
    installationGeneration: "g2",
  });
  await click("Refresh");
  expect(
    (container.querySelector("[name=consent]") as HTMLInputElement).checked,
  ).toBe(false);
  expect(
    (container.querySelector("[name=maximum]") as HTMLInputElement).value,
  ).toBe("");
  await submit();
  expect(transport.write).not.toHaveBeenCalled();
});
