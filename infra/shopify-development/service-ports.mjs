import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

/** @typedef {{ mysql: string, sqlHttp: string }} ServicePorts */
/** @type {Readonly<ServicePorts>} */
export const DEFAULT_SERVICE_PORTS = Object.freeze({
  mysql: "3307",
  sqlHttp: "3902",
});
const reserved = new Set(["3002", "8079", "8890", "8891", "9002"]);

/** Only the two SQL host bindings are configurable; resource identities stay fixed. */
export function validateServicePorts(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "mysql,sqlHttp" ||
    Object.values(value).some(
      (port) =>
        typeof port !== "string" ||
        !/^[1-9][0-9]{3,4}$/.test(port) ||
        Number(port) < 1024 ||
        Number(port) > 65535 ||
        reserved.has(port),
    ) ||
    value.mysql === value.sqlHttp
  )
    throw new Error("Invalid isolated SQL ports");
  return Object.freeze({ mysql: value.mysql, sqlHttp: value.sqlHttp });
}

/** Absence preserves existing checkouts. An unsafe or invalid file fails closed. */
export function readLocalServicePorts(root) {
  const directory = join(root, ".env.loyalty-secrets.local");
  const path = join(directory, "service-ports.json");
  // Do not follow a symlinked parent even when the configuration file is absent.
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700)
      throw new Error("Unsafe isolated configuration directory");
  } catch (error) {
    if (error.code === "ENOENT") return DEFAULT_SERVICE_PORTS;
    throw error;
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error("Unsafe isolated port configuration");
  } catch (error) {
    if (error.code === "ENOENT") return DEFAULT_SERVICE_PORTS;
    throw error;
  }
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    throw new Error("Unsafe isolated port configuration");
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024)
      throw new Error("Unsafe isolated port configuration");
    return validateServicePorts(JSON.parse(readFileSync(descriptor, "utf8")));
  } finally {
    closeSync(descriptor);
  }
}

/** Compose 2.24.4+ replaces the old bindings instead of publishing both. */
export function servicePortsComposeOverride(value) {
  const ports = validateServicePorts(value);
  return `services:\n  mysql:\n    ports: !override ["127.0.0.1:${ports.mysql}:3306"]\n  sql-http:\n    ports: !override ["127.0.0.1:${ports.sqlHttp}:3900"]\n`;
}

export function parseProvisioningFlags(args) {
  if (args.length === 1 && args[0] === "--confirm-local-provisioning")
    return DEFAULT_SERVICE_PORTS;
  if (args.length !== 3 || !args.includes("--confirm-local-provisioning"))
    throw new Error("Invalid provisioning flags");
  const entries = ["mysql", "sql-http"].map((name) => {
    const matches = args.filter((arg) => arg.startsWith(`--${name}-port=`));
    if (matches.length !== 1) throw new Error("Invalid provisioning flags");
    return matches[0].split("=")[1];
  });
  // Reject extra '=' suffixes, not just the parsed prefix.
  if (
    !args.every(
      (arg) =>
        arg === "--confirm-local-provisioning" ||
        /^--(mysql|sql-http)-port=[0-9]+$/.test(arg),
    )
  )
    throw new Error("Invalid provisioning flags");
  return validateServicePorts({ mysql: entries[0], sqlHttp: entries[1] });
}
