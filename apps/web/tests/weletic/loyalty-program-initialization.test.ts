import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? files(path)
      : /\.tsx?$/.test(path)
        ? [path]
        : [];
  });
}

// Complement runtime route tests: the historical Prisma default is active, so
// every application initializer must explicitly opt into a draft. No migration
// or test-fixture writer is included in this runtime source inventory.
describe("runtime loyalty program initialization inventory", () => {
  it("requires explicit draft defaults for every direct create/upsert writer", () => {
    const writers: string[] = [];
    for (const path of [...files("app"), ...files("lib")]) {
      const text = readFileSync(path, "utf8");
      if (!text.includes("weleticLoyaltyProgram")) continue;
      const source = ts.createSourceFile(
        path,
        text,
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression)
        ) {
          const call = node.expression;
          if (
            ["create", "upsert"].includes(call.name.text) &&
            ts.isPropertyAccessExpression(call.expression) &&
            call.expression.name.text === "weleticLoyaltyProgram"
          ) {
            writers.push(path);
            const args = node.arguments[0];
            if (!args || !ts.isObjectLiteralExpression(args))
              throw new Error(`Unreviewed initializer: ${path}`);
            const property = (
              object: ts.ObjectLiteralExpression,
              name: string,
            ) =>
              object.properties.find(
                (item): item is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(item) &&
                  item.name.getText(source) === name,
              );
            const data = property(
              args,
              call.name.text === "create" ? "data" : "create",
            )?.initializer;
            if (!data || !ts.isObjectLiteralExpression(data))
              throw new Error(`Unreviewed create data: ${path}`);
            const status = property(data, "status")?.initializer.getText(
              source,
            );
            expect(status, path).toBe(
              path === "lib/weletic/loyalty/settings-writer.ts" &&
                call.name.text === "upsert"
                ? 'status ?? "draft"'
                : '"draft"',
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(writers.length).toBeGreaterThanOrEqual(8);
    expect(writers).toContain("lib/weletic/loyalty/settings-writer.ts");
  });
});
