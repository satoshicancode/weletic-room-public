// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useCommunicationsUnsavedGuard } from "../../../../packages/shopify-app/app/communications-unsaved-guard";
const mocks = vi.hoisted(() => ({
  blocker: { state: "blocked", proceed: vi.fn(), reset: vi.fn() },
  unload: vi.fn(),
  block: vi.fn(),
}));
vi.mock(
  "../../../../packages/shopify-app/node_modules/@remix-run/react",
  () => ({
    useBlocker: (dirty: boolean) => {
      mocks.block(dirty);
      return mocks.blocker;
    },
    useBeforeUnload: mocks.unload,
  }),
);
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
function Fixture({ dirty = true }: { dirty?: boolean }) {
  useCommunicationsUnsavedGuard({ dirty, locale: "ja" });
  return null;
}
afterEach(() => vi.restoreAllMocks());
it.each([true, false])(
  "requires explicit discard confirmation (%s)",
  async (discard) => {
    vi.clearAllMocks();
    mocks.blocker.state = "blocked";
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(discard);
    const node = document.createElement("div");
    const root = createRoot(node);
    await act(async () => root.render(createElement(Fixture)));
    expect(confirm).toHaveBeenCalledWith(
      "通知の未保存の変更を破棄して、このページを離れますか？",
    );
    expect(mocks.blocker.proceed).toHaveBeenCalledTimes(discard ? 1 : 0);
    expect(mocks.blocker.reset).toHaveBeenCalledTimes(discard ? 0 : 1);
    const event = { preventDefault: vi.fn(), returnValue: undefined };
    mocks.unload.mock.calls.at(-1)![0](event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.returnValue).toBe("");
    await act(async () => root.unmount());
  },
);
it("does not prevent navigation/unload for a clean draft", async () => {
  vi.clearAllMocks();
  mocks.blocker.state = "unblocked";
  const confirm = vi.spyOn(window, "confirm");
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Fixture, { dirty: false })));
  expect(mocks.block).toHaveBeenLastCalledWith(false);
  expect(confirm).not.toHaveBeenCalled();
  const event = { preventDefault: vi.fn() };
  mocks.unload.mock.calls.at(-1)![0](event);
  expect(event.preventDefault).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
