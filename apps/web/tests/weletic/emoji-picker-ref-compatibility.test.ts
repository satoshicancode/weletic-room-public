import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { adaptReactRef } from "../../ui/shared/compatible-react-ref";

describe("emoji picker React ref boundary", () => {
  it("preserves object, null and missing refs", () => {
    const ref = { current: null };
    expect(adaptReactRef(ref)).toBe(ref);
    expect(adaptReactRef(null)).toBeNull();
    expect(adaptReactRef(undefined)).toBeUndefined();
  });

  it("forwards attachment and legacy null detachment", () => {
    const source = vi.fn();
    const ref = adaptReactRef<{ id: string }>(source);
    if (typeof ref !== "function") throw new Error("Expected callback ref");
    const node = { id: "emoji" };
    expect(ref(node)).toBeUndefined();
    expect(ref(null)).toBeUndefined();
    expect(source.mock.calls).toEqual([[node], [null]]);
  });

  it("retains React 19 cleanup while normalizing its return value to void", () => {
    const cleanup = vi.fn(() => "ignored foreign return value");
    const source = vi.fn(() => cleanup);
    const ref = adaptReactRef<{ id: string }>(source);
    if (typeof ref !== "function") throw new Error("Expected callback ref");
    const dispose = ref({ id: "emoji" });
    expect(cleanup).not.toHaveBeenCalled();
    if (typeof dispose !== "function") throw new Error("Expected cleanup");
    expect(dispose()).toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("does not swallow callback or cleanup errors", () => {
    const failure = new Error("ref lifecycle failure");
    for (const cleanupPhase of [false, true]) {
      const ref = adaptReactRef(() => {
        if (!cleanupPhase) throw failure;
        return () => {
          throw failure;
        };
      });
      if (typeof ref !== "function") throw new Error("Expected callback ref");
      expect(() => {
        const dispose = ref(null);
        if (typeof dispose === "function") dispose();
      }).toThrow(failure);
    }
  });

  it("type-checks the real components against both installed React type copies", () => {
    const web = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const webRequire = createRequire(join(web, "package.json"));
    const libraryRequire = createRequire(
      join(web, "../../packages/utils/package.json"),
    );
    const appTypes = join(
      dirname(webRequire.resolve("@types/react/package.json")),
      "index.d.ts",
    );
    const libraryTypes = join(
      dirname(libraryRequire.resolve("@types/react/package.json")),
      "index.d.ts",
    );
    // PNPM can resolve frimousse's undeclared type peer through either copy.
    // Force the divergent case; a normal local tsc can miss the CI failure.
    expect(appTypes).not.toBe(libraryTypes);
    const fixture = join(web, "__emoji-ref-type-regression__.tsx");
    const source = `
      import type { EmojiPickerListRowProps } from "frimousse";
      export const UnadaptedRow = ({children, ...props}: EmojiPickerListRowProps) =>
        <div {...props}>{children}</div>;
    `;
    const options: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (
      file,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) =>
      file === fixture
        ? ts.createSourceFile(
            file,
            source,
            languageVersion,
            true,
            ts.ScriptKind.TSX,
          )
        : getSourceFile(
            file,
            languageVersion,
            onError,
            shouldCreateNewSourceFile,
          );
    host.resolveModuleNames = (names, containingFile) =>
      names.map((name) => {
        if (name === "react" && containingFile.includes("/frimousse/"))
          return {
            resolvedFileName: libraryTypes,
            extension: ts.Extension.Dts,
            isExternalLibraryImport: true,
          };
        return ts.resolveModuleName(name, containingFile, options, host)
          .resolvedModule;
      });
    const program = ts.createProgram(
      [fixture, join(web, "ui/shared/emoji-picker-components.tsx")],
      options,
      host,
    );
    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      );
    expect(
      errors
        .filter((error) => error.file?.fileName === fixture)
        .map((error) => error.code),
    ).toEqual([2322]);
    expect(
      errors
        .filter((error) => error.file?.fileName !== fixture)
        .map((error) =>
          ts.flattenDiagnosticMessageText(error.messageText, "\n"),
        ),
    ).toEqual([]);
  }, 30000);
});
