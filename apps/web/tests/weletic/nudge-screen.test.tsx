// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultLoyaltyNudgeSettings,
  type LoyaltyNudgeRequest,
  type LoyaltyNudgeResponse,
} from "../../lib/weletic/loyalty/nudge-contract";
import { nudgeCopy } from "../../ui/weletic/loyalty/nudge-copy";
import { LoyaltyNudgeScreen } from "../../ui/weletic/loyalty/nudge-screen";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let node: HTMLDivElement;
let root: Root;
let response: LoyaltyNudgeResponse;
beforeEach(() => {
  response = {
    storeId: "private-store",
    installationGeneration: "private-generation",
    revision: "a".repeat(64),
    programConfigured: true,
    capabilities: { configure: true },
    settings: defaultLoyaltyNudgeSettings(),
  };
  node = document.createElement("div");
  document.body.appendChild(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});
async function render(
  request: (input: LoyaltyNudgeRequest) => Promise<LoyaltyNudgeResponse>,
  onNavigationStateChange = vi.fn(),
) {
  await act(async () =>
    root.render(
      createElement(LoyaltyNudgeScreen, { request, onNavigationStateChange }),
    ),
  );
}
async function select(index: number, value: string) {
  await act(async () => {
    const input = node.querySelectorAll("select")[index];
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function edit(value: string) {
  await act(async () => {
    const input = node.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function dispatchSubmit() {
  node
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
async function submit() {
  await act(async () => dispatchSubmit());
}
it.each(["en", "ja", "vi"] as const)(
  "renders %s with no private identifiers",
  async (locale) => {
    await render(vi.fn().mockResolvedValue(response));
    await select(0, locale);
    expect(node.querySelector("h1")?.textContent).toBe(nudgeCopy[locale].title);
    expect(node.innerHTML).not.toContain(response.storeId);
    expect(node.innerHTML).not.toContain(response.installationGeneration);
    expect(node.querySelectorAll("select")[1].options).toHaveLength(3);
  },
);
it("saves all policies and languages with the current fences, retaining edits across tabs", async () => {
  const request = vi
    .fn()
    .mockImplementation(async (input) =>
      input.operation === "read"
        ? response
        : { ...response, revision: "b".repeat(64), settings: input.settings },
    );
  const navigation = vi.fn();
  await render(request, navigation);
  await edit("Signup edited");
  await select(1, "points_spending");
  await select(2, "ja");
  await edit("ポイント案内");
  await submit();
  const input = request.mock.calls[1][0];
  expect(input.expectedRevision).toBe(response.revision);
  expect(input.expectedInstallationGeneration).toBe(
    response.installationGeneration,
  );
  expect(input.settings.policies[0].templates.en.title).toBe("Signup edited");
  expect(input.settings.policies[1].templates.ja.title).toBe("ポイント案内");
  expect(
    input.settings.policies.every((p: { enabled: boolean }) => !p.enabled),
  ).toBe(true);
  expect(navigation).toHaveBeenLastCalledWith({ dirty: false, locale: "en" });
  expect(node.textContent).toContain(nudgeCopy.en.saved);
});
it("rejects markup without rendering HTML", async () => {
  const request = vi.fn().mockResolvedValue(response);
  await render(request);
  await edit('<img src="x">');
  await submit();
  expect(request).toHaveBeenCalledTimes(1);
  expect(node.querySelector("img")).toBeNull();
  expect(node.textContent).toContain(nudgeCopy.en.invalid);
});
it.each(["ambiguous", "stale", "cross-store"])(
  "fails closed after %s acknowledgement",
  async (mode) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockImplementation(async (input) => {
        if (mode === "ambiguous") throw new Error("private-failure");
        return {
          ...response,
          revision: mode === "stale" ? response.revision : "b".repeat(64),
          storeId: mode === "cross-store" ? "other-store" : response.storeId,
          settings: input.settings,
        };
      });
    await render(request);
    await edit("Changed");
    await submit();
    await submit();
    expect(request).toHaveBeenCalledTimes(2);
    expect(node.querySelector("fieldset")?.disabled).toBe(true);
    expect(node.textContent).not.toContain("private-failure");
    expect(node.querySelector("textarea")?.value).toBe("Changed");
    expect(node.textContent).toContain(nudgeCopy.en.error);
  },
);
it.each(["readonly", "missing"])("disables writes when %s", async (mode) => {
  const request = vi.fn().mockResolvedValue({
    ...response,
    capabilities: { configure: mode !== "readonly" },
    programConfigured: mode !== "missing",
  });
  await render(request);
  await submit();
  expect(request).toHaveBeenCalledTimes(1);
  expect(node.querySelector("fieldset")?.disabled).toBe(true);
});
it("coalesces same-tick duplicate submissions", async () => {
  let complete!: (value: LoyaltyNudgeResponse) => void;
  const request = vi
    .fn()
    .mockResolvedValueOnce(response)
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
  await render(request);
  await edit("Changed");
  await act(async () => {
    dispatchSubmit();
    dispatchSubmit();
  });
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () =>
    complete({
      ...response,
      revision: "b".repeat(64),
      settings: request.mock.calls[1][0].settings,
    }),
  );
});
it("ignores late responses from a replaced transport", async () => {
  let complete!: (value: LoyaltyNudgeResponse) => void;
  await render(
    vi.fn().mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    ),
  );
  await render(
    vi
      .fn()
      .mockResolvedValue({ ...response, capabilities: { configure: false } }),
  );
  await act(async () => complete(response));
  expect(node.querySelector("fieldset")?.disabled).toBe(true);
});
it("discards without writing or enabling a nudge", async () => {
  const request = vi.fn().mockResolvedValue(response);
  const navigation = vi.fn();
  await render(request, navigation);
  await edit("Changed");
  await act(async () =>
    Array.from(node.querySelectorAll("button"))
      .find((b) => b.textContent === nudgeCopy.en.discard)!
      .click(),
  );
  expect(node.querySelector("textarea")?.value).toBe(
    response.settings.policies[0].templates.en.title,
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect(navigation).toHaveBeenLastCalledWith({ dirty: false, locale: "en" });
});
it("shows invalid field locations without submission, including another language", async () => {
  const request = vi.fn().mockResolvedValue(response);
  await render(request);
  await select(2, "ja");
  await edit("");
  await select(2, "en");
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("JA");
  expect(node.querySelector('[role="alert"]')?.textContent).toContain(
    nudgeCopy.en.subject,
  );
  expect(
    node.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
  ).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
});
it("marks message content with its own language", async () => {
  await render(vi.fn().mockResolvedValue(response));
  await select(2, "vi");
  expect(node.querySelector("article")?.lang).toBe("en");
  expect(node.querySelector("textarea")?.lang).toBe("vi");
  expect(node.querySelector("section h3")?.getAttribute("lang")).toBe("vi");
});
it("ignores a pending save after the transport changes", async () => {
  let complete!: (value: LoyaltyNudgeResponse) => void;
  const request = vi
    .fn()
    .mockResolvedValueOnce(response)
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
  await render(request);
  await edit("Old pending edit");
  await submit();
  const current = {
    ...response,
    storeId: "new-private-store",
    capabilities: { configure: false },
  };
  await render(vi.fn().mockResolvedValue(current));
  await act(async () =>
    complete({
      ...response,
      revision: "b".repeat(64),
      settings: request.mock.calls[1][0].settings,
    }),
  );
  expect(node.querySelector("fieldset")?.disabled).toBe(true);
  expect(node.querySelector("textarea")?.value).toBe(
    current.settings.policies[0].templates.en.title,
  );
  expect(node.textContent).not.toContain(nudgeCopy.en.saved);
});
