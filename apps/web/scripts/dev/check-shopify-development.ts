import { parse } from "dotenv-flow";
import { realpathSync } from "node:fs";
import { checkDevelopmentEnvironment } from "../../lib/weletic/shopify/development-preflight";

const flags = ["web", "shopify", "retained-web", "retained-shopify"] as const;

try {
  const args = process.argv.slice(2);
  if (args.length !== flags.length) throw new Error("arguments");
  const paths = flags.map((flag) => {
    const matches = args.filter((arg) => arg.startsWith(`--${flag}=`));
    if (matches.length !== 1) throw new Error("arguments");
    return realpathSync(matches[0].slice(flag.length + 3));
  });
  if (new Set(paths).size !== paths.length) throw new Error("same file");
  // parse() reads exactly these files, without dotenv discovery or process.env
  // mutation. Never use config(), import a service, or print caught errors.
  const [web, shopify, retainedWeb, retainedShopify] = paths.map((path) =>
    parse(path),
  );
  const report = checkDevelopmentEnvironment({
    web,
    shopify,
    retainedWeb,
    retainedShopify,
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "configuration_consistent" ? 0 : 1;
} catch {
  console.error(
    "Preflight could not read four distinct environment files. Supply --web=PATH --shopify=PATH --retained-web=PATH --retained-shopify=PATH. No services were contacted or changed.",
  );
  process.exitCode = 2;
}
