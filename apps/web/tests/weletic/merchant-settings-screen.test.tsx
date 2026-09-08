// @vitest-environment jsdom
import type { MerchantSettingsView as MerchantSettings } from "@/lib/weletic/merchant-settings/merchant-contract";
import { merchantSettingsCopy } from "@/ui/weletic/merchant-settings/copy";
import {
  MerchantSettingsScreen,
  type MerchantSettingsTransport,
} from "@/ui/weletic/merchant-settings/settings-form";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, useSWRConfig, type State } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const initial: MerchantSettings = {
  storeId: "store-a",
  installationGeneration: "g1",
  revision: 0,
  settings: {
    brandName: null,
    logoUrl: null,
    accentColor: null,
    timeZone: null,
    defaultLocale: "en",
    shopperEmailPaused: false,
  },
  branding: { name: "Legacy brand", source: "legacy_loyalty" },
  modules: {
    loyalty: { status: "disabled", killSwitchActive: false },
    reviews: { enabled: false, requestEmailEnabled: false, updatedAt: null },
  },
};
describe("shared merchant settings screen", () => {
  let container: HTMLDivElement;
  let root: Root;
  let transport: MerchantSettingsTransport;
  let data: MerchantSettings;
  let cache: Map<string, State<unknown, unknown>>;
  let revalidate: () => Promise<unknown>;
  function RevalidationProbe() {
    const { mutate } = useSWRConfig();
    revalidate = () => mutate(() => true);
    return null;
  }
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    cache = new Map();
    data = structuredClone(initial);
    transport = {
      scopeKey: "workspace-a",
      read: vi.fn(async () => data),
      save: vi.fn(async (input) => {
        data = {
          ...data,
          revision: data.revision + 1,
          settings: { ...data.settings, ...input.settings },
        };
      }),
      loyalty: vi.fn(),
      reviews: vi.fn(),
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  async function render(canEdit = true) {
    await act(async () =>
      root.render(
        createElement(
          SWRConfig,
          {
            value: {
              provider: () => cache,
              dedupingInterval: 0,
              shouldRetryOnError: false,
              keepPreviousData: true,
            },
          },
          createElement(
            Fragment,
            null,
            createElement(RevalidationProbe),
            createElement(MerchantSettingsScreen, { transport, canEdit }),
          ),
        ),
      ),
    );
  }
  function field(label: string) {
    const input = Array.from(container.querySelectorAll("label"))
      .find((node) => node.textContent?.includes(label))
      ?.querySelector("input, select");
    if (
      !(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)
    )
      throw new Error(`Missing field ${label}`);
    return input;
  }
  async function edit(label: string, value: string) {
    const input = field(label);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        input instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLSelectElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(
        new Event(input instanceof HTMLInputElement ? "input" : "change", {
          bubbles: true,
        }),
      );
    });
  }
  it("saves only changed fields with revision/generation and retains confirmation after reload", async () => {
    await render();
    await edit("Brand name", "New brand");
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(transport.save).toHaveBeenCalledWith({
      expectedRevision: 0,
      expectedInstallationGeneration: "g1",
      settings: { brandName: "New brand" },
    });
    expect(container.textContent).toContain("Settings saved");
    expect((field("Brand name") as HTMLInputElement).value).toBe("New brand");
  });
  it("keeps module operations separate from unsaved branding", async () => {
    await render();
    await edit("Brand name", "Unsaved");
    const buttons = Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent === "Enable",
    );
    await act(async () => buttons[0].click());
    expect(transport.loyalty).toHaveBeenCalledWith({
      status: "active",
      expectedStatus: "disabled",
      expectedInstallationGeneration: "g1",
    });
    const refreshedButtons = Array.from(
      container.querySelectorAll("button"),
    ).filter((button) => button.textContent === "Enable");
    await act(async () => refreshedButtons[1].click());
    expect(transport.reviews).toHaveBeenCalledWith({
      enabled: true,
      expectedUpdatedAt: null,
      expectedInstallationGeneration: "g1",
    });
    expect(transport.save).not.toHaveBeenCalled();
  });
  it("disables write controls for nonowners", async () => {
    await render(false);
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    for (const button of container.querySelectorAll("button"))
      expect(button.disabled).toBe(true);
  });
  it("fails closed for staff without capability hints", async () => {
    transport.staffScoped = true;
    await render();
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    for (const button of container.querySelectorAll("button"))
      expect(button.disabled).toBe(true);
  });
  it.each(["en", "ja", "vi"] as const)(
    "reuses the editor with only appearance fields in %s",
    async (locale) => {
      transport.staffScoped = true;
      transport.appearanceOnly = true;
      transport.read = async () => ({
        storeId: data.storeId,
        installationGeneration: data.installationGeneration,
        revision: data.revision,
        branding: data.branding,
        settings: {
          brandName: data.settings.brandName,
          logoUrl: data.settings.logoUrl,
          accentColor: data.settings.accentColor,
        },
      });
      await render();
      await edit("Interface language", locale);
      const text = merchantSettingsCopy[locale];
      expect(container.querySelectorAll("input")).toHaveLength(3);
      expect(container.textContent).not.toContain(text.modules);
      expect(container.textContent).not.toContain(text.timezoneNote);
      expect(field(text.brandName).disabled).toBe(false);
      await edit(text.brandName, "Appearance only");
      await act(async () =>
        container
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          ),
      );
      expect(transport.save).toHaveBeenCalledWith({
        expectedRevision: 0,
        expectedInstallationGeneration: "g1",
        settings: { brandName: "Appearance only" },
      });
      expect(transport.loyalty).not.toHaveBeenCalled();
      expect(transport.reviews).not.toHaveBeenCalled();
    },
  );
  it("keeps the write guard while revalidation replaces the editor", async () => {
    let finish: () => void = () => {};
    transport.save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await edit("Brand name", "Pending");
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(transport.save).toHaveBeenCalledTimes(1);
    await act(async () => {
      await revalidate();
    });
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(transport.save).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(container.querySelector("fieldset")!.disabled).toBe(false);
  });
  it("requires an explicit fresh read after an uncertain save", async () => {
    transport.save = vi.fn(async () => {
      throw new Error("uncertain delivery");
    });
    await render();
    await edit("Brand name", "Stale draft");
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(container.querySelector("form")).toBeNull();
    await act(async () => {
      await revalidate();
    });
    expect(container.querySelector("form")).toBeNull();
    const reload = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === merchantSettingsCopy.en.reload,
    )!;
    await act(async () => reload.click());
    expect(container.querySelector("form")).not.toBeNull();
    expect(field("Brand name").value).toBe("");
    expect(transport.save).toHaveBeenCalledTimes(1);
  });
  it("maps staff controls independently and prevents initialization", async () => {
    transport.staffScoped = true;
    data.capabilities = {
      settings: true,
      appearance: false,
      loyalty: true,
      reviews: false,
    };
    data.modules.loyalty.status = "not_configured";
    await render();
    expect(field("Brand name").disabled).toBe(true);
    expect(field("Saved timezone").disabled).toBe(false);
    for (const button of Array.from(
      container.querySelectorAll("button"),
    ).filter((node) => node.textContent === "Enable"))
      expect(button.disabled).toBe(true);
  });
  it("does not reuse settings from a previous visit before fresh authorization", async () => {
    await render();
    expect(container.textContent).toContain("Legacy brand");
    await act(async () => root.render(null));
    let reject: (error: Error) => void = () => {};
    transport.read = vi.fn(
      () =>
        new Promise<MerchantSettings>((_resolve, deny) => {
          reject = deny;
        }),
    );
    await render();
    expect(container.textContent).not.toContain("Legacy brand");
    expect(container.querySelector("form")).toBeNull();
    await act(async () => reject(new Error("Access revoked")));
    expect(container.querySelector("form")).toBeNull();
    expect(transport.read).toHaveBeenCalledTimes(1);
  });
  it.each(["en", "ja", "vi"] as const)(
    "shows explicit stored-only timezone and policy caveats in %s",
    async (locale) => {
      await render();
      await edit("Interface language", locale);
      expect(container.textContent).toContain(
        merchantSettingsCopy[locale].timezoneNote,
      );
      expect(container.textContent).toContain(
        merchantSettingsCopy[locale].legacy,
      );
      expect(container.querySelector("section")!.lang).toBe(locale);
    },
  );
  it("removes previous tenant settings while the next scope is loading", async () => {
    await render();
    expect(container.textContent).toContain("Legacy brand");
    transport = {
      ...transport,
      scopeKey: "workspace-b",
      read: () => new Promise(() => {}),
    };
    await render();
    expect(container.textContent).not.toContain("Legacy brand");
    expect(container.textContent).toContain("Loading settings");
  });
});
