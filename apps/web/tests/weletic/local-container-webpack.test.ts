import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

test("local memory settings are opt-in and preserve ordinary/dev build defaults", () => {
  const source = readFileSync(
    new URL("../../next.config.js", import.meta.url),
    "utf8",
  );
  for (const flag of [undefined, "", "true", "0", "1"]) {
    const target = { exports: {} };
    runInNewContext(source, {
      module: target,
      process: { env: { WELETIC_LOCAL_CONTAINER_BUILD: flag } },
      console: { warn: () => {} },
      require: (name: string) => {
        if (name !== "next-plausible")
          throw new Error("Unexpected config dependency");
        return { withPlausibleProxy: () => (config: unknown) => config };
      },
    });
    const config = target.exports as {
      webpack: (
        input: Record<string, unknown>,
        context: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    for (const dev of [false, true]) {
      const cache = { type: "filesystem" };
      const output = config.webpack(
        { cache, parallelism: 100, module: {} },
        { dev, isServer: false },
      );
      expect(output.cache).toBe(flag === "1" && !dev ? false : cache);
      expect(output.parallelism).toBe(flag === "1" && !dev ? 2 : 100);
    }
  }
});
