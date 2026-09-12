import { AppProvider, Pagination } from "@shopify/polaris";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { merchantPolarisTranslations } from "../app/merchant-polaris-translations";

describe("merchant Polaris language resources", () => {
  it.each([
    ["en", "This page is ready"],
    ["ja", "このページの準備が整いました"],
    ["vi", "Trang này đã sẵn sàng"],
  ] as const)(
    "provides localized accessibility messages in %s",
    (locale, ready) => {
      const translations = merchantPolarisTranslations[locale];
      expect(
        translations.Polaris.Page.Header.pageReadyAccessibilityLabel,
      ).toContain(ready);
      const markup = renderToStaticMarkup(
        createElement(
          AppProvider,
          { i18n: translations },
          createElement(Pagination, { hasPrevious: true, hasNext: true }),
        ),
      );
      expect(markup).toContain(translations.Polaris.Pagination.next);
      expect(markup).toContain(translations.Polaris.Pagination.previous);
    },
  );
});
