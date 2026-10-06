import { describe, expect, it } from "vitest";
import {
  buildUrl,
  constructURLFromUTMParams,
  getFileExtension,
  getParamsFromURL,
  getPathnameFromUrl,
  getPrettyUrl,
  getSearchParams,
  getSearchParamsWithArray,
  getUTMParamsFromURL,
  getUrlFromString,
  getUrlFromStringIfValid,
  getUrlObjFromString,
  getUrlWithoutUTMParams,
  isSafeLinkHref,
  isValidUrl,
  normalizeUrl,
  safeDecodeURIComponent,
} from "../src/functions";

describe("isValidUrl", () => {
  it("validates absolute URLs with protocol", () => {
    expect(isValidUrl("https://dub.co")).toBe(true);
    expect(isValidUrl("http://localhost:3000")).toBe(true);
    expect(isValidUrl("https://example.com/path?foo=bar#hash")).toBe(true);
  });

  it("rejects invalid URL formats", () => {
    expect(isValidUrl("not-a-url")).toBe(false);
    expect(isValidUrl("example.com")).toBe(false);
    expect(isValidUrl("")).toBe(false);
    expect(isValidUrl("http://")).toBe(false);
  });
});

describe("isSafeLinkHref", () => {
  it("accepts safe protocols", () => {
    expect(isSafeLinkHref("https://dub.co")).toBe(true);
    expect(isSafeLinkHref("http://example.com")).toBe(true);
    expect(isSafeLinkHref("mailto:team@dub.co")).toBe(true);
  });

  it("rejects unsafe or malicious schemes", () => {
    expect(isSafeLinkHref("javascript:alert(1)")).toBe(false);
    expect(isSafeLinkHref("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeLinkHref("vbscript:msgbox(1)")).toBe(false);
  });

  it("rejects falsy, null, or malformed inputs", () => {
    expect(isSafeLinkHref("")).toBe(false);
    expect(isSafeLinkHref(null)).toBe(false);
    expect(isSafeLinkHref(undefined)).toBe(false);
    expect(isSafeLinkHref("not-a-url")).toBe(false);
  });
});

describe("getUrlFromString & helpers", () => {
  it("adds https to bare domains", () => {
    expect(getUrlFromString("dub.co")).toBe("https://dub.co/");
    expect(getUrlFromString("sub.domain.org/path")).toBe("https://sub.domain.org/path");
  });

  it("preserves already valid URLs", () => {
    expect(getUrlFromString("https://dub.co/pricing")).toBe("https://dub.co/pricing");
  });

  it("handles strings with spaces gracefully", () => {
    expect(getUrlFromString("some query string")).toBe("some query string");
  });

  it("getUrlObjFromString returns URL object or null", () => {
    expect(getUrlObjFromString("https://dub.co")?.hostname).toBe("dub.co");
    expect(getUrlObjFromString("dub.co")?.protocol).toBe("https:");
    expect(getUrlObjFromString("invalid string")).toBeNull();
  });

  it("getUrlFromStringIfValid returns string or null", () => {
    expect(getUrlFromStringIfValid("https://dub.co")).toBe("https://dub.co");
    expect(getUrlFromStringIfValid("dub.co")).toBe("https://dub.co/");
    expect(getUrlFromStringIfValid("invalid string")).toBeNull();
  });
});

describe("searchParams extraction", () => {
  it("getSearchParams extracts key-value pairs", () => {
    const params = getSearchParams("https://dub.co?utm_source=twitter&ref=abc");
    expect(params).toEqual({
      utm_source: "twitter",
      ref: "abc",
    });
  });

  it("getSearchParamsWithArray handles multiple values for same key", () => {
    const params = getSearchParamsWithArray("https://dub.co?tag=tech&tag=news&single=val");
    expect(params).toEqual({
      tag: ["tech", "news"],
      single: "val",
    });
  });

  it("getParamsFromURL filters out empty values", () => {
    const params = getParamsFromURL("https://dub.co?a=1&b=&c=hello");
    expect(params).toEqual({
      a: "1",
      c: "hello",
    });
    expect(getParamsFromURL("")).toEqual({});
  });
});

describe("UTM parameters manipulation", () => {
  it("constructURLFromUTMParams injects UTM parameters", () => {
    const result = constructURLFromUTMParams("https://dub.co", {
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "summer_sale",
    });
    const parsed = new URL(result);
    expect(parsed.searchParams.get("utm_source")).toBe("google");
    expect(parsed.searchParams.get("utm_medium")).toBe("cpc");
    expect(parsed.searchParams.get("utm_campaign")).toBe("summer_sale");
  });

  it("constructURLFromUTMParams removes empty/null parameters", () => {
    const result = constructURLFromUTMParams("https://dub.co?utm_source=google&keep=1", {
      utm_source: null,
    });
    const parsed = new URL(result);
    expect(parsed.searchParams.has("utm_source")).toBe(false);
    expect(parsed.searchParams.get("keep")).toBe("1");
  });

  it("getUTMParamsFromURL extracts only recognized UTM tags", () => {
    const url = "https://dub.co?utm_source=twitter&utm_medium=social&custom_param=123&ref=partner";
    const utms = getUTMParamsFromURL(url);
    expect(utms).toEqual({
      utm_source: "twitter",
      utm_medium: "social",
      ref: "partner",
    });
  });

  it("getUrlWithoutUTMParams removes UTM parameters while keeping other params", () => {
    const url = "https://dub.co/blog?utm_source=google&utm_campaign=launch&page=2&sort=recent";
    const cleaned = getUrlWithoutUTMParams(url);
    const parsed = new URL(cleaned);
    expect(parsed.searchParams.has("utm_source")).toBe(false);
    expect(parsed.searchParams.has("utm_campaign")).toBe(false);
    expect(parsed.searchParams.get("page")).toBe("2");
    expect(parsed.searchParams.get("sort")).toBe("recent");
  });
});

describe("URL normalization and formatting", () => {
  it("getPrettyUrl removes protocol, www and trailing slash", () => {
    expect(getPrettyUrl("https://www.dub.co/pricing/")).toBe("dub.co/pricing");
    expect(getPrettyUrl("http://dub.co")).toBe("dub.co");
    expect(getPrettyUrl("https://sub.domain.com/path")).toBe("sub.domain.com/path");
    expect(getPrettyUrl(null)).toBe("");
    expect(getPrettyUrl("")).toBe("");
  });

  it("normalizeUrl strips query parameters and hash fragments", () => {
    expect(normalizeUrl("https://dub.co/features?ref=producthunt&dark=true#pricing")).toBe(
      "https://dub.co/features",
    );
  });

  it("getFileExtension extracts extension uppercase", () => {
    expect(getFileExtension("https://dub.co/assets/logo.png")).toBe("PNG");
    expect(getFileExtension("https://dub.co/docs/report.pdf?version=2")).toBe("PDF");
    expect(getFileExtension("https://dub.co/archive.tar.gz")).toBe("GZ");
  });

  it("getPathnameFromUrl extracts relative pathname with search params", () => {
    expect(getPathnameFromUrl("https://dub.co/features?tab=sync")).toBe("features?tab=sync");
    expect(getPathnameFromUrl("/dashboard/analytics")).toBe("dashboard/analytics");
  });

  it("buildUrl constructs valid URLs with parameters", () => {
    const url = buildUrl("https://api.dub.co/links", {
      workspaceId: "ws_123",
      limit: 50,
      archived: false,
      empty: null,
      omitted: undefined,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("workspaceId")).toBe("ws_123");
    expect(parsed.searchParams.get("limit")).toBe("50");
    expect(parsed.searchParams.get("archived")).toBe("false");
    expect(parsed.searchParams.has("empty")).toBe(false);
    expect(parsed.searchParams.has("omitted")).toBe(false);
  });

  it("safeDecodeURIComponent handles encoded strings and invalid sequences", () => {
    expect(safeDecodeURIComponent("hello%20world")).toBe("hello world");
    expect(safeDecodeURIComponent("%E0%A4%A")).toBe("%E0%A4%A"); // malformed URI component
  });
});
