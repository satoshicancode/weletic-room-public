import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  en,
  ja,
  vi,
} from "../src/i18n";

describe("i18n locale constants", () => {
  it("defines supported locales (en, vi, ja)", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "vi", "ja"]);
    expect(SUPPORTED_LOCALES).toHaveLength(3);
  });

  it("sets DEFAULT_LOCALE to 'en'", () => {
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("provides comprehensive metadata for each supported locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const meta = LOCALE_LABELS[locale];
      expect(meta).toBeDefined();
      expect(typeof meta.label).toBe("string");
      expect(typeof meta.native).toBe("string");
      expect(typeof meta.flag).toBe("string");
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.native.length).toBeGreaterThan(0);
      expect(meta.flag.length).toBeGreaterThan(0);
    }

    expect(LOCALE_LABELS.en).toEqual({
      label: "English",
      native: "English",
      flag: "🇺🇸",
    });

    expect(LOCALE_LABELS.vi).toEqual({
      label: "Vietnamese",
      native: "Tiếng Việt",
      flag: "🇻🇳",
    });

    expect(LOCALE_LABELS.ja).toEqual({
      label: "Japanese",
      native: "日本語",
      flag: "🇯🇵",
    });
  });
});

describe("i18n translation dictionaries", () => {
  it("includes required top-level domain sections across all dictionaries", () => {
    const requiredSections = ["common", "partner", "admin", "auth"] as const;
    const dictionaries = [
      { name: "en", dict: en },
      { name: "vi", dict: vi },
      { name: "ja", dict: ja },
    ];

    for (const { name, dict } of dictionaries) {
      for (const section of requiredSections) {
        expect(
          dict[section],
          `Dictionary ${name} missing section ${section}`,
        ).toBeDefined();
        expect(typeof dict[section]).toBe("object");
      }
    }
  });

  it("provides common actions across en, vi, ja", () => {
    const commonActions = [
      "save",
      "cancel",
      "delete",
      "edit",
      "create",
      "confirm",
      "back",
    ] as const;

    for (const action of commonActions) {
      expect((en.common as any).actions?.[action]).toBeDefined();
      expect((vi.common as any).actions?.[action]).toBeDefined();
      expect((ja.common as any).actions?.[action]).toBeDefined();
    }

    expect((en.common as any).actions.save).toBe("Save changes");
    expect((vi.common as any).actions.save).toBe("Lưu thay đổi");
    expect((ja.common as any).actions.save).toBe("変更を保存");
  });
});
