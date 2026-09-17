import { deferLocalContainerPrerender } from "@/lib/weletic/local-container-prerender";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, expect, test, vi } from "vitest";

const appRoot = fileURLToPath(new URL("../../app", import.meta.url));
const routes = [
  "(ee)/partners.dub.co/(apply)/[programSlug]/(default)/layout.tsx",
  "(ee)/partners.dub.co/(auth-login-register)/(generic)/layout.tsx",
  "(ee)/partners.dub.co/(auth-login-register)/(program)/[programSlug]/layout.tsx",
  "(ee)/partners.dub.co/(dashboard)/marketplace/[[...segments]]/page.tsx",
];

afterEach(() => vi.unstubAllEnvs());

// Execute each real route module. Stub only its imported rendering/data layer;
// do not copy or replace generateStaticParams or the build-phase predicate.
function loadRoute(path: string, query: ReturnType<typeof vi.fn>) {
  const source = readFileSync(path, "utf8");
  const output = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  runInNewContext(output, {
    exports,
    require: (name: string): unknown => {
      if (name === "@/lib/weletic/local-container-prerender")
        return { deferLocalContainerPrerender };
      if (name === "@/lib/fetchers/get-program-slugs")
        return { getProgramSlugs: query };
      if (name === "@/lib/zod/schemas/groups")
        return { DEFAULT_PARTNER_GROUP: { slug: "fixture-default" } };
      if (name === "@/ui/program-marketplace/pages/marketplace-program-page")
        return {
          generateMarketplaceProgramStaticParams: query,
          revalidate: 3600,
        };
      if (name === "../../(generic)/layout")
        return loadRoute(resolve(dirname(path), name + ".tsx"), query);
      return {};
    },
  });
  return exports as { generateStaticParams: () => Promise<unknown[]> };
}

for (const route of routes) {
  test(`${route}: loyalty release skips excluded portal enumeration only during build`, async () => {
    vi.stubEnv("WELETIC_LOCAL_CONTAINER_BUILD", "0");
    vi.stubEnv("WELETIC_WEB_BUILD_PROFILE", "loyalty-only");
    const query = vi.fn().mockResolvedValue([]);
    const routeModule = loadRoute(resolve(appRoot, route), query);
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    expect(await routeModule.generateStaticParams()).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    await routeModule.generateStaticParams();
    expect(query).toHaveBeenCalledOnce();
  });
  test(`${route}: only the opt-in production build avoids route enumeration`, async () => {
    const path = resolve(appRoot, route);
    const marketplace = route.includes("marketplace");
    const fixtures = marketplace
      ? [{ segments: ["fixture-program"] }]
      : [{ slug: "fixture-program" }];
    const query = vi.fn().mockResolvedValue(fixtures);
    const routeModule = loadRoute(path, query);
    for (const flag of [undefined, "0", "true", "1"]) {
      for (const phase of [
        undefined,
        "phase-development-server",
        "phase-production-server",
        "phase-production-build",
      ]) {
        vi.stubEnv("WELETIC_LOCAL_CONTAINER_BUILD", flag);
        vi.stubEnv("NEXT_PHASE", phase);
        query.mockClear();
        const result = await routeModule.generateStaticParams();
        const deferred = flag === "1" && phase === "phase-production-build";
        expect(query).toHaveBeenCalledTimes(deferred ? 0 : 1);
        expect(result).toEqual(
          deferred
            ? []
            : marketplace
              ? fixtures
              : [
                  {
                    programSlug: "fixture-program",
                    ...(route.includes("(apply)")
                      ? { groupSlug: "fixture-default" }
                      : {}),
                  },
                ],
        );
      }
    }
    vi.stubEnv("WELETIC_LOCAL_CONTAINER_BUILD", "0");
    query.mockRejectedValueOnce(new Error("enumeration failed"));
    await expect(routeModule.generateStaticParams()).rejects.toThrow(
      "enumeration failed",
    );
  });

  test(`${route}: retains on-demand routing`, () => {
    const path = resolve(appRoot, route);
    const sources = [path];
    for (let dir = dirname(path); dir.startsWith(appRoot); dir = dirname(dir)) {
      const layout = resolve(dir, "layout.tsx");
      if (existsSync(layout)) sources.push(layout);
    }
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/export\s+const\s+dynamicParams\s*=\s*false/);
      expect(source).not.toMatch(
        /export\s+const\s+dynamic\s*=\s*["']error["']/,
      );
    }
  });
}
