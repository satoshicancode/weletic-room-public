import { createHash } from "node:crypto";
import { readFile, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { inter } from "../../styles/fonts";

// Capture the real shared module's loader input; the test below feeds that
// configuration into Next's actual filesystem/font loader, not a duplicate.
vi.mock("next/font/local", () => ({ default: (options: unknown) => options }));
vi.mock("geist/font/mono", () => ({
  GeistMono: { variable: "--font-geist-mono" },
}));

const require = createRequire(import.meta.url);
const asset = fileURLToPath(
  new URL("../../styles/inter/InterVariable.woff2", import.meta.url),
);

test("bundled Inter matches the pinned unmodified asset and license", () => {
  expect(createHash("sha256").update(readFileSync(asset)).digest("hex")).toBe(
    "693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3",
  );
  const license = readFileSync(
    new URL("../../styles/inter/LICENSE.txt", import.meta.url),
  );
  expect(
    readFileSync(
      new URL("../../public/fonts/inter/LICENSE.txt", import.meta.url),
    ),
  ).toEqual(license);
  expect(createHash("sha256").update(license).digest("hex")).toBe(
    "262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a",
  );
  const source = readFileSync(
    new URL("../../styles/fonts.ts", import.meta.url),
    "utf8",
  );
  expect(source).not.toContain("next/font/google");
  expect(source).toContain('src: "./inter/InterVariable.woff2"');
  expect(source).toContain('variable: "--font-inter"');
  expect(source).toContain('weight: "100 900"');
});

test("real Next local font loader emits Inter and measured fallback without downloads", async () => {
  const loader =
    require("next/dist/compiled/@next/font/dist/local/loader").default;
  const emitted: Buffer[] = [];
  const result = await loader({
    functionName: "",
    variableName: "inter",
    data: [inter],
    emitFontFile: (buffer: Buffer) => {
      emitted.push(buffer);
      return "/_next/static/media/inter.woff2";
    },
    resolve: async () => asset,
    loaderContext: { fs: { readFile } },
  });
  expect(emitted).toEqual([readFileSync(asset)]);
  expect(result.css).toContain("font-weight: 100 900");
  expect(result.css).toContain("font-display: swap");
  expect(result.variable).toBe("--font-inter");
  expect(result.adjustFontFallback).toEqual({
    fallbackFont: "Arial",
    ascentOverride: "89.79%",
    descentOverride: "22.36%",
    lineGapOverride: "0.00%",
    sizeAdjust: "107.89%",
  });
});
