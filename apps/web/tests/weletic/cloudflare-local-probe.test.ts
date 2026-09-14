import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("local container probe contracts and synthetic worker shutdown", () => {
  const suite = fileURLToPath(
    new URL(
      "../../../../infra/cloudflare-local/probe.test.mjs",
      import.meta.url,
    ),
  );
  const emulatorSuite = fileURLToPath(
    new URL(
      "../../../../infra/cloudflare-emulator/process-group.test.mjs",
      import.meta.url,
    ),
  );
  const output = execFileSync(
    process.execPath,
    [
      "--test",
      suite,
      emulatorSuite,
      fileURLToPath(
        new URL(
          "../../../../infra/cloudflare-emulator/container-cleanup.test.mjs",
          import.meta.url,
        ),
      ),
    ],
    {
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  expect(output).toContain(
    "SIGTERM completes the in-flight synthetic batch before exiting",
  );
}, 20_000);
