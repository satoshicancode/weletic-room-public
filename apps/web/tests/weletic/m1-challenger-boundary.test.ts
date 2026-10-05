import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const WEB_DIR = path.resolve(REPO_ROOT, "apps/web");
const SHOPIFY_APP_DIR = path.resolve(REPO_ROOT, "packages/shopify-app");
const CONTRACTS_DIR = path.resolve(REPO_ROOT, "packages/contracts");
const CONTRACTS_SRC_DIR = path.resolve(CONTRACTS_DIR, "src");

const EXCLUDED_DIRS = new Set(["node_modules", "build", ".turbo", ".git", ".next", "dist"]);
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function getAllFiles(dir: string, extensions = CODE_EXTS): string[] {
  const results: string[] = [];
  function walk(current: string) {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (extensions.has(path.extname(entry.name))) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

function extractImports(filePath: string) {
  const content = fs.readFileSync(filePath, "utf8");
  const imports: Array<{ type: string; specifier: string; raw: string }> = [];

  const staticRe = /(?:import|export)\s+(?:type\s+)?(?:[\w*\s{},]*\s+from\s+)?["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = staticRe.exec(content)) !== null) {
    imports.push({ type: "static", specifier: m[1], raw: m[0] });
  }

  const dynamicRe = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynamicRe.exec(content)) !== null) {
    imports.push({ type: "dynamic", specifier: m[1], raw: m[0] });
  }

  const requireRe = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = requireRe.exec(content)) !== null) {
    imports.push({ type: "require", specifier: m[1], raw: m[0] });
  }

  return { content, imports };
}

describe("Milestone 1 Empirical Challenger: Boundary & Isolation Audit (PKG-01)", () => {
  it("ensures zero inverted imports or relative escapes from packages/shopify-app into apps/web", () => {
    const shopifyFiles = getAllFiles(SHOPIFY_APP_DIR);
    expect(shopifyFiles.length).toBeGreaterThan(50);

    const violations: Array<{ file: string; specifier: string; resolved: string }> = [];

    for (const file of shopifyFiles) {
      const relPath = path.relative(REPO_ROOT, file);
      const { content, imports } = extractImports(file);

      // Check literal substring
      expect(content.includes("apps/web")).toBe(false);
      expect(content.includes("apps\\web")).toBe(false);

      for (const imp of imports) {
        const spec = imp.specifier;
        if (spec.startsWith(".")) {
          const resolved = path.resolve(path.dirname(file), spec);
          if (resolved.startsWith(WEB_DIR)) {
            violations.push({ file: relPath, specifier: spec, resolved: path.relative(REPO_ROOT, resolved) });
          }
        } else if (spec.startsWith("@/")) {
          violations.push({ file: relPath, specifier: spec, resolved: "apps/web" });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("ensures packages/shopify-app configurations contain zero alias bypasses into apps/web", () => {
    // tsconfig.json paths
    const tsconfigPath = path.join(SHOPIFY_APP_DIR, "tsconfig.json");
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
    const paths = tsconfig.compilerOptions?.paths || {};
    for (const [alias, targets] of Object.entries(paths) as Array<[string, string[]]>) {
      for (const target of targets) {
        const resolved = path.resolve(SHOPIFY_APP_DIR, target);
        expect(resolved.startsWith(WEB_DIR)).toBe(false);
      }
    }

    // postcss.config.cjs
    const postcssPath = path.join(SHOPIFY_APP_DIR, "postcss.config.cjs");
    const postcssContent = fs.readFileSync(postcssPath, "utf8");
    expect(postcssContent.includes("apps/web")).toBe(false);

    // vite.config.ts
    const vitePath = path.join(SHOPIFY_APP_DIR, "vite.config.ts");
    const viteContent = fs.readFileSync(vitePath, "utf8");
    expect(viteContent.includes("apps/web")).toBe(false);

    // vitest.config.ts
    const vitestPath = path.join(SHOPIFY_APP_DIR, "vitest.config.ts");
    const vitestContent = fs.readFileSync(vitestPath, "utf8");
    expect(vitestContent.includes("apps/web")).toBe(false);
  });

  it("ensures @weletic/contracts has zero external runtime dependencies outside zod and node built-ins", () => {
    const pkgPath = path.join(CONTRACTS_DIR, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

    const deps = Object.keys(pkg.dependencies || {});
    expect(deps).toEqual(["zod"]);
    expect(pkg.peerDependencies).toBeUndefined();

    const contractFiles = getAllFiles(CONTRACTS_SRC_DIR);
    expect(contractFiles.length).toBeGreaterThan(40);

    const allowedModules = new Set(["zod", "zod/v4", "node:crypto", "crypto", "node:buffer", "buffer"]);
    const disallowedImports: Array<{ file: string; specifier: string }> = [];

    for (const file of contractFiles) {
      const relPath = path.relative(REPO_ROOT, file);
      const { imports } = extractImports(file);
      for (const imp of imports) {
        const spec = imp.specifier;
        if (spec.startsWith(".")) {
          const resolved = path.resolve(path.dirname(file), spec);
          expect(resolved.startsWith(CONTRACTS_SRC_DIR)).toBe(true);
        } else if (!allowedModules.has(spec)) {
          disallowedImports.push({ file: relPath, specifier: spec });
        }
      }
    }

    expect(disallowedImports).toEqual([]);
  });

  it("ensures @weletic/contracts module graph is strictly acyclic (0 circular dependencies)", () => {
    const contractFiles = getAllFiles(CONTRACTS_SRC_DIR);

    function resolveModuleTarget(fromDir: string, specifier: string): string | null {
      const target = path.resolve(fromDir, specifier);
      if (fs.existsSync(target + ".ts")) return target + ".ts";
      if (fs.existsSync(target + "/index.ts")) return target + "/index.ts";
      if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
      return null;
    }

    const graph = new Map<string, string[]>();
    for (const file of contractFiles) {
      const { imports } = extractImports(file);
      const deps: string[] = [];
      for (const imp of imports) {
        if (imp.specifier.startsWith(".")) {
          const resolved = resolveModuleTarget(path.dirname(file), imp.specifier);
          if (resolved) deps.push(resolved);
        }
      }
      graph.set(file, deps);
    }

    const visited = new Set<string>();
    const recStack = new Set<string>();
    const cycles: string[] = [];

    function detectCycles(node: string, trail: string[] = []) {
      visited.add(node);
      recStack.add(node);
      trail.push(node);

      for (const neighbor of graph.get(node) || []) {
        if (!visited.has(neighbor)) {
          detectCycles(neighbor, [...trail]);
        } else if (recStack.has(neighbor)) {
          const cycleStartIdx = trail.indexOf(neighbor);
          const cycle = [...trail.slice(cycleStartIdx), neighbor].map((p) =>
            path.relative(CONTRACTS_SRC_DIR, p),
          );
          cycles.push(cycle.join(" -> "));
        }
      }
      recStack.delete(node);
    }

    for (const file of graph.keys()) {
      if (!visited.has(file)) {
        detectCycles(file);
      }
    }

    expect(cycles).toEqual([]);
  });

  it("ensures every @weletic/contracts export imported by shopify-app resolves successfully", () => {
    const shopifyFiles = getAllFiles(SHOPIFY_APP_DIR);
    const unresolvable: Array<{ file: string; specifier: string }> = [];

    for (const file of shopifyFiles) {
      const { imports } = extractImports(file);
      for (const imp of imports) {
        if (imp.specifier.startsWith("@weletic/contracts/")) {
          const subpath = imp.specifier.replace("@weletic/contracts/", "");
          const targetTs = path.join(CONTRACTS_SRC_DIR, subpath + ".ts");
          const targetIndex = path.join(CONTRACTS_SRC_DIR, subpath, "index.ts");
          if (!fs.existsSync(targetTs) && !fs.existsSync(targetIndex)) {
            unresolvable.push({ file: path.relative(REPO_ROOT, file), specifier: imp.specifier });
          }
        }
      }
    }

    expect(unresolvable).toEqual([]);
  });
});
