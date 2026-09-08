import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { decrypt, encrypt } from "../../lib/encryption";

export const BASIC_LIFECYCLE_RECOVERY_CAPSULE_VERSION = 1 as const;
export const BASIC_LIFECYCLE_RECOVERY_CAPSULE_KIND =
  "weletic-a1-basic-lifecycle-recovery" as const;
export const BASIC_LIFECYCLE_RECOVERY_CAPSULE_ALGORITHM =
  "aes-256-gcm:v1" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type EncodedRecoveryValue =
  | { type: "null" }
  | { type: "undefined" }
  | { type: "boolean"; value: boolean }
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "bigint"; value: string }
  | { type: "date"; value: string }
  | { type: "array"; value: EncodedRecoveryValue[] }
  | { type: "set"; value: EncodedRecoveryValue[] }
  | {
      type: "map";
      value: Array<[EncodedRecoveryValue, EncodedRecoveryValue]>;
    }
  | {
      type: "object";
      value: Array<[string, EncodedRecoveryValue]>;
    };

export interface BasicLifecycleRecoveryReportBinding {
  absolutePath: string;
  capsuleSha256BeforeBinding: string;
  reportSha256: string;
}

export interface BasicLifecycleRecoveryCapsule<TState> {
  kind: typeof BASIC_LIFECYCLE_RECOVERY_CAPSULE_KIND;
  version: typeof BASIC_LIFECYCLE_RECOVERY_CAPSULE_VERSION;
  sequence: number;
  checkpoint: string;
  createdAt: string;
  updatedAt: string;
  stateSha256: string;
  state: TState;
  reportBinding: BasicLifecycleRecoveryReportBinding | null;
}

interface SerializedBasicLifecycleRecoveryCapsule {
  kind: typeof BASIC_LIFECYCLE_RECOVERY_CAPSULE_KIND;
  version: typeof BASIC_LIFECYCLE_RECOVERY_CAPSULE_VERSION;
  sequence: number;
  checkpoint: string;
  createdAt: string;
  updatedAt: string;
  stateSha256: string;
  state: EncodedRecoveryValue;
  reportBinding: BasicLifecycleRecoveryReportBinding | null;
}

interface EncryptedBasicLifecycleRecoveryCapsule {
  version: typeof BASIC_LIFECYCLE_RECOVERY_CAPSULE_VERSION;
  algorithm: typeof BASIC_LIFECYCLE_RECOVERY_CAPSULE_ALGORITHM;
  ciphertext: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new Error(`${label} has an unsupported or missing field.`);
  }
}

function encodeRecoveryValue(
  value: unknown,
  ancestors = new WeakSet<object>(),
): EncodedRecoveryValue {
  if (value === null) return { type: "null" };
  if (value === undefined) return { type: "undefined" };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Recovery state cannot contain a non-finite number.");
    }
    return { type: "number", value };
  }
  if (typeof value === "bigint") {
    return { type: "bigint", value: value.toString() };
  }
  if (typeof value !== "object") {
    throw new Error("Recovery state contains an unsupported runtime value.");
  }
  if (ancestors.has(value)) {
    throw new Error("Recovery state cannot contain a cyclic value.");
  }
  ancestors.add(value);
  try {
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) {
        throw new Error("Recovery state contains an invalid Date.");
      }
      return { type: "date", value: value.toISOString() };
    }
    if (Array.isArray(value)) {
      return {
        type: "array",
        value: value.map((entry) => encodeRecoveryValue(entry, ancestors)),
      };
    }
    if (value instanceof Set) {
      return {
        type: "set",
        value: [...value].map((entry) => encodeRecoveryValue(entry, ancestors)),
      };
    }
    if (value instanceof Map) {
      return {
        type: "map",
        value: [...value].map(([key, entry]) => [
          encodeRecoveryValue(key, ancestors),
          encodeRecoveryValue(entry, ancestors),
        ]),
      };
    }
    if (!isPlainObject(value)) {
      const toJSON = (value as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") {
        return encodeRecoveryValue(toJSON.call(value), ancestors);
      }
      throw new Error("Recovery state contains an unsupported object type.");
    }
    return {
      type: "object",
      value: Object.keys(value)
        .sort()
        .map((key) => [key, encodeRecoveryValue(value[key], ancestors)]),
    };
  } finally {
    ancestors.delete(value);
  }
}

function decodeRecoveryValue(value: unknown): unknown {
  if (!isPlainObject(value) || typeof value.type !== "string") {
    throw new Error("Recovery capsule contains an invalid encoded value.");
  }
  switch (value.type) {
    case "null":
      assertExactKeys(value, ["type"], "Encoded null");
      return null;
    case "undefined":
      assertExactKeys(value, ["type"], "Encoded undefined");
      return undefined;
    case "boolean":
      assertExactKeys(value, ["type", "value"], "Encoded boolean");
      if (typeof value.value !== "boolean") {
        throw new Error("Recovery capsule contains an invalid boolean.");
      }
      return value.value;
    case "number":
      assertExactKeys(value, ["type", "value"], "Encoded number");
      if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
        throw new Error("Recovery capsule contains an invalid number.");
      }
      return value.value;
    case "string":
      assertExactKeys(value, ["type", "value"], "Encoded string");
      if (typeof value.value !== "string") {
        throw new Error("Recovery capsule contains an invalid string.");
      }
      return value.value;
    case "bigint":
      assertExactKeys(value, ["type", "value"], "Encoded bigint");
      if (
        typeof value.value !== "string" ||
        !/^(?:0|-?[1-9]\d*)$/.test(value.value)
      ) {
        throw new Error("Recovery capsule contains an invalid bigint.");
      }
      return BigInt(value.value);
    case "date": {
      assertExactKeys(value, ["type", "value"], "Encoded Date");
      if (typeof value.value !== "string") {
        throw new Error("Recovery capsule contains an invalid Date.");
      }
      const date = new Date(value.value);
      if (
        !Number.isFinite(date.getTime()) ||
        date.toISOString() !== value.value
      ) {
        throw new Error("Recovery capsule contains a non-canonical Date.");
      }
      return date;
    }
    case "array":
    case "set": {
      assertExactKeys(value, ["type", "value"], `Encoded ${value.type}`);
      if (!Array.isArray(value.value)) {
        throw new Error(`Recovery capsule contains an invalid ${value.type}.`);
      }
      const decoded = value.value.map(decodeRecoveryValue);
      return value.type === "set" ? new Set(decoded) : decoded;
    }
    case "map": {
      assertExactKeys(value, ["type", "value"], "Encoded map");
      if (
        !Array.isArray(value.value) ||
        value.value.some((entry) => !Array.isArray(entry) || entry.length !== 2)
      ) {
        throw new Error("Recovery capsule contains an invalid map.");
      }
      const decoded = new Map<unknown, unknown>();
      for (const entry of value.value) {
        const key = decodeRecoveryValue(entry[0]);
        if (decoded.has(key)) {
          throw new Error("Recovery capsule contains a duplicate map key.");
        }
        decoded.set(key, decodeRecoveryValue(entry[1]));
      }
      return decoded;
    }
    case "object": {
      assertExactKeys(value, ["type", "value"], "Encoded object");
      if (
        !Array.isArray(value.value) ||
        value.value.some(
          (entry) =>
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== "string",
        )
      ) {
        throw new Error("Recovery capsule contains an invalid object.");
      }
      const decoded: Record<string, unknown> = {};
      for (const entry of value.value) {
        if (Object.prototype.hasOwnProperty.call(decoded, entry[0])) {
          throw new Error("Recovery capsule contains a duplicate object key.");
        }
        Object.defineProperty(decoded, entry[0], {
          value: decodeRecoveryValue(entry[1]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return decoded;
    }
    default:
      throw new Error("Recovery capsule uses an unsupported value tag.");
  }
}

function sha256(value: string | Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertCanonicalIsoTimestamp(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function assertReportBinding(
  value: unknown,
): BasicLifecycleRecoveryReportBinding | null {
  if (value === null) return null;
  if (!isPlainObject(value)) {
    throw new Error("Recovery capsule report binding is invalid.");
  }
  assertExactKeys(
    value,
    ["absolutePath", "capsuleSha256BeforeBinding", "reportSha256"],
    "Recovery capsule report binding",
  );
  if (
    typeof value.absolutePath !== "string" ||
    !path.isAbsolute(value.absolutePath) ||
    typeof value.capsuleSha256BeforeBinding !== "string" ||
    !SHA256_PATTERN.test(value.capsuleSha256BeforeBinding) ||
    typeof value.reportSha256 !== "string" ||
    !SHA256_PATTERN.test(value.reportSha256)
  ) {
    throw new Error("Recovery capsule report binding is invalid.");
  }
  return {
    absolutePath: value.absolutePath,
    capsuleSha256BeforeBinding: value.capsuleSha256BeforeBinding,
    reportSha256: value.reportSha256,
  };
}

function serializePlaintextEnvelope<TState>(
  capsule: Omit<BasicLifecycleRecoveryCapsule<TState>, "stateSha256">,
) {
  const encodedState = encodeRecoveryValue(capsule.state);
  const stateBytes = JSON.stringify(encodedState);
  const envelope: SerializedBasicLifecycleRecoveryCapsule = {
    kind: capsule.kind,
    version: capsule.version,
    sequence: capsule.sequence,
    checkpoint: capsule.checkpoint,
    createdAt: capsule.createdAt,
    updatedAt: capsule.updatedAt,
    stateSha256: sha256(stateBytes),
    state: encodedState,
    reportBinding: capsule.reportBinding,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function isCanonicalBase64(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

export function assertBasicLifecycleRecoveryEncryptionKey() {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  const isExactHexKey =
    typeof encryptionKey === "string" &&
    /^[a-fA-F0-9]{64}$/.test(encryptionKey);
  const isExactBase64Key =
    isCanonicalBase64(encryptionKey) &&
    Buffer.from(encryptionKey, "base64").length === 32;
  if (!isExactHexKey && !isExactBase64Key) {
    throw new Error(
      "Recovery capsules require ENCRYPTION_KEY to be an exact 32-byte canonical base64 or 64-character hexadecimal key.",
    );
  }
}

function serializeEncryptedEnvelope<TState>(
  capsule: Omit<BasicLifecycleRecoveryCapsule<TState>, "stateSha256">,
  forbiddenValues: Iterable<string | null | undefined>,
) {
  assertBasicLifecycleRecoveryEncryptionKey();
  const plaintext = serializePlaintextEnvelope(capsule);
  assertForbiddenValuesAbsent(plaintext, forbiddenValues);
  const envelope: EncryptedBasicLifecycleRecoveryCapsule = {
    version: BASIC_LIFECYCLE_RECOVERY_CAPSULE_VERSION,
    algorithm: BASIC_LIFECYCLE_RECOVERY_CAPSULE_ALGORITHM,
    ciphertext: encrypt(plaintext),
  };
  const bytes = `${JSON.stringify(envelope, null, 2)}\n`;
  assertForbiddenValuesAbsent(bytes, forbiddenValues);
  return bytes;
}

function parsePlaintextEnvelope<TState = unknown>(
  bytes: string,
  validateState?: (state: unknown) => void,
): BasicLifecycleRecoveryCapsule<TState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("Recovery capsule plaintext is not valid JSON.");
  }
  if (!isPlainObject(parsed)) {
    throw new Error("Recovery capsule plaintext is not an object.");
  }
  assertExactKeys(
    parsed,
    [
      "kind",
      "version",
      "sequence",
      "checkpoint",
      "createdAt",
      "updatedAt",
      "stateSha256",
      "state",
      "reportBinding",
    ],
    "Recovery capsule plaintext",
  );
  if (
    parsed.kind !== BASIC_LIFECYCLE_RECOVERY_CAPSULE_KIND ||
    parsed.version !== BASIC_LIFECYCLE_RECOVERY_CAPSULE_VERSION ||
    typeof parsed.sequence !== "number" ||
    !Number.isSafeInteger(parsed.sequence) ||
    parsed.sequence < 0 ||
    typeof parsed.checkpoint !== "string" ||
    !parsed.checkpoint.trim() ||
    parsed.checkpoint.length > 200 ||
    typeof parsed.stateSha256 !== "string" ||
    !SHA256_PATTERN.test(parsed.stateSha256)
  ) {
    throw new Error("Recovery capsule plaintext header is invalid.");
  }
  const createdAt = assertCanonicalIsoTimestamp(
    parsed.createdAt,
    "Recovery capsule createdAt",
  );
  const updatedAt = assertCanonicalIsoTimestamp(
    parsed.updatedAt,
    "Recovery capsule updatedAt",
  );
  const encodedStateBytes = JSON.stringify(parsed.state);
  if (sha256(encodedStateBytes) !== parsed.stateSha256) {
    throw new Error("Recovery capsule state digest does not match.");
  }
  const state = decodeRecoveryValue(parsed.state);
  if (validateState) validateState(state);
  return {
    kind: BASIC_LIFECYCLE_RECOVERY_CAPSULE_KIND,
    version: BASIC_LIFECYCLE_RECOVERY_CAPSULE_VERSION,
    sequence: parsed.sequence,
    checkpoint: parsed.checkpoint,
    createdAt,
    updatedAt,
    stateSha256: parsed.stateSha256,
    state: state as TState,
    reportBinding: assertReportBinding(parsed.reportBinding),
  };
}

export function parseBasicLifecycleRecoveryCapsule<TState = unknown>(
  bytes: string,
  validateState?: (state: unknown) => void,
): BasicLifecycleRecoveryCapsule<TState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("Encrypted recovery capsule is not valid JSON.");
  }
  if (!isPlainObject(parsed)) {
    throw new Error("Encrypted recovery capsule is not an object.");
  }
  assertExactKeys(
    parsed,
    ["version", "algorithm", "ciphertext"],
    "Encrypted recovery capsule",
  );
  if (
    parsed.version !== BASIC_LIFECYCLE_RECOVERY_CAPSULE_VERSION ||
    parsed.algorithm !== BASIC_LIFECYCLE_RECOVERY_CAPSULE_ALGORITHM ||
    !isCanonicalBase64(parsed.ciphertext) ||
    Buffer.from(parsed.ciphertext, "base64").length < 29
  ) {
    throw new Error("Encrypted recovery capsule header is invalid.");
  }
  assertBasicLifecycleRecoveryEncryptionKey();
  let plaintext: string;
  try {
    plaintext = decrypt(parsed.ciphertext);
  } catch {
    throw new Error(
      "Encrypted recovery capsule authentication failed; the key is wrong or the file was tampered with.",
    );
  }
  return parsePlaintextEnvelope<TState>(plaintext, validateState);
}

function currentUid() {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Recovery capsules require an operating-system owner id.");
  }
  return uid;
}

function assertSecureDirectoryTraversal(
  directory: string,
  pathLabel: "recovery-state" | "durable artifact",
) {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const segment of directory.slice(parsed.root.length).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`The ${pathLabel} path cannot traverse a symlink.`);
    }
    const sharedWritable = (stat.mode & 0o022) !== 0;
    const rootOwnedStickyDirectory =
      stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (sharedWritable && !rootOwnedStickyDirectory) {
      throw new Error(
        `The ${pathLabel} path cannot traverse a group/world-writable directory.`,
      );
    }
  }
}

function assertSecureRecoveryParent(absolutePath: string) {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error("The recovery-state path must be absolute.");
  }
  const parent = path.dirname(absolutePath);
  assertSecureDirectoryTraversal(parent, "recovery-state");
  const parentStat = fs.lstatSync(parent);
  if (parentStat.uid !== currentUid() || (parentStat.mode & 0o777) !== 0o700) {
    throw new Error(
      "The recovery-state parent must be owner-owned and mode-0700.",
    );
  }
  return parent;
}

function assertSecureExistingCapsule(absolutePath: string) {
  const stat = fs.lstatSync(absolutePath);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.uid !== currentUid() ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      "The existing recovery capsule must be an owner-owned mode-0600 regular file.",
    );
  }
  return stat;
}

function assertOwnerPrivateRegularFileStat(stat: fs.Stats, label: string) {
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.uid !== currentUid() ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error(`${label} must be an owner-owned mode-0600 regular file.`);
  }
  return stat;
}

function assertForbiddenValuesAbsent(
  bytes: string,
  forbiddenValues: Iterable<string | null | undefined>,
) {
  for (const value of forbiddenValues) {
    if (value && value.length >= 3 && bytes.includes(value)) {
      throw new Error(
        "Recovery capsule serialization included a runtime secret.",
      );
    }
  }
}

function fsyncDirectory(directory: string) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertSecureArtifactParent(absolutePath: string) {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error("The durable artifact path must be absolute.");
  }
  const parent = path.dirname(path.normalize(absolutePath));
  assertSecureDirectoryTraversal(parent, "durable artifact");
  const parentStat = fs.lstatSync(parent);
  if (
    parentStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    parentStat.uid !== currentUid() ||
    (parentStat.mode & 0o200) === 0 ||
    (parentStat.mode & 0o022) !== 0
  ) {
    throw new Error(
      "The durable artifact parent must be an owner-owned, owner-writable, non-shared regular directory.",
    );
  }
  return parent;
}

/**
 * Publishes a complete mode-0600 artifact without ever replacing an existing
 * path. The temporary inode is fully written and synced before the same-
 * directory hard-link publication, and the directory is synced before return.
 */
export function writeExclusiveDurableArtifact(
  absolutePath: string,
  bytes: string | Buffer,
  testHooks: { beforePublication?: () => void } = {},
) {
  const normalizedPath = path.normalize(absolutePath);
  const parent = assertSecureArtifactParent(normalizedPath);
  try {
    fs.lstatSync(normalizedPath);
    throw new Error("The durable artifact path already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporaryPath = path.join(
    parent,
    `.${path.basename(normalizedPath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  const durableBytes =
    typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  let descriptor: number | undefined;
  let temporaryCreated = false;
  let published = false;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporaryCreated = true;
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, durableBytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    assertOwnerPrivateRegularFileStat(
      fs.lstatSync(temporaryPath),
      "The durable artifact temporary file",
    );
    testHooks.beforePublication?.();
    try {
      fs.linkSync(temporaryPath, normalizedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("The durable artifact path already exists.");
      }
      throw error;
    }
    published = true;

    const temporaryStat = assertOwnerPrivateRegularFileStat(
      fs.lstatSync(temporaryPath),
      "The durable artifact temporary file",
    );
    const publishedStat = assertOwnerPrivateRegularFileStat(
      fs.lstatSync(normalizedPath),
      "The durable artifact",
    );
    if (
      temporaryStat.dev !== publishedStat.dev ||
      temporaryStat.ino !== publishedStat.ino
    ) {
      throw new Error("The durable artifact publication inode changed.");
    }

    fs.unlinkSync(temporaryPath);
    temporaryCreated = false;
    fsyncDirectory(parent);
    assertOwnerPrivateRegularFileStat(
      fs.lstatSync(normalizedPath),
      "The durable artifact",
    );
    return normalizedPath;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporaryCreated) {
      try {
        fs.unlinkSync(temporaryPath);
        fsyncDirectory(parent);
      } catch {
        // Preserve the original write/publication error. A published artifact
        // is already a complete synced inode and must never be removed here.
      }
    } else if (published) {
      // Publication has already been made durable in the successful path.
      // This branch intentionally does not remove the final artifact if a
      // post-publication validation or directory sync failed.
    }
  }
}

function writeExclusivePrivateFile(absolutePath: string, bytes: string) {
  const parent = assertSecureRecoveryParent(absolutePath);
  try {
    const existing = fs.lstatSync(absolutePath);
    if (existing.isSymbolicLink()) {
      throw new Error("The recovery-state path cannot be a symlink.");
    }
    throw new Error("The recovery-state path already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = fs.openSync(
      absolutePath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    descriptor = undefined;
    if (created) {
      try {
        fs.unlinkSync(absolutePath);
      } catch {
        // Preserve the original write error.
      }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fsyncDirectory(parent);
  assertSecureExistingCapsule(absolutePath);
}

function replacePrivateFileAtomically(
  absolutePath: string,
  bytes: string,
  beforeRename?: () => void,
) {
  const parent = assertSecureRecoveryParent(absolutePath);
  assertSecureExistingCapsule(absolutePath);
  const temporaryPath = path.join(
    parent,
    `.${path.basename(absolutePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  let temporaryCreated = false;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporaryCreated = true;
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertSecureExistingCapsule(absolutePath);
    beforeRename?.();
    fs.renameSync(temporaryPath, absolutePath);
    temporaryCreated = false;
    fsyncDirectory(parent);
    assertSecureExistingCapsule(absolutePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporaryCreated) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The original checkpoint error remains authoritative.
      }
    }
  }
}

export function readBasicLifecycleRecoveryCapsuleFile<TState = unknown>(
  absolutePath: string,
  validateState?: (state: unknown) => void,
) {
  assertSecureRecoveryParent(absolutePath);
  assertSecureExistingCapsule(absolutePath);
  return parseBasicLifecycleRecoveryCapsule<TState>(
    fs.readFileSync(absolutePath, "utf8"),
    validateState,
  );
}

export function sha256BasicLifecycleFile(absolutePath: string) {
  return sha256(fs.readFileSync(absolutePath));
}

/**
 * A crash-safe single-writer journal. The caller must retain its database/run
 * exclusivity for the lifetime of this object; the sequence fence detects a
 * writer that committed between checkpoints but is not a cross-process lock.
 */
export class BasicLifecycleRecoveryCapsuleFile<TState> {
  readonly absolutePath: string;
  private createdAt?: string;
  private sequence = -1;

  constructor(
    recoveryStatePath: string,
    private readonly testHooks: {
      beforeAtomicRename?: () => void;
      beforeSecureUnlinkDirectoryFsync?: () => void;
      fsyncReport?: (descriptor: number) => void;
    } = {},
  ) {
    if (!path.isAbsolute(recoveryStatePath)) {
      throw new Error("The recovery-state path must be absolute.");
    }
    this.absolutePath = path.normalize(recoveryStatePath);
  }

  load(validateState?: (state: unknown) => void) {
    const current = readBasicLifecycleRecoveryCapsuleFile<TState>(
      this.absolutePath,
      validateState,
    );
    this.createdAt = current.createdAt;
    this.sequence = current.sequence;
    return current;
  }

  create({
    state,
    checkpoint,
    forbiddenValues = [],
  }: {
    state: TState;
    checkpoint: string;
    forbiddenValues?: Iterable<string | null | undefined>;
  }) {
    if (this.createdAt !== undefined || this.sequence !== -1) {
      throw new Error("Recovery capsule file is already initialized.");
    }
    const timestamp = new Date().toISOString();
    const bytes = serializeEncryptedEnvelope(
      {
        kind: BASIC_LIFECYCLE_RECOVERY_CAPSULE_KIND,
        version: BASIC_LIFECYCLE_RECOVERY_CAPSULE_VERSION,
        sequence: 0,
        checkpoint,
        createdAt: timestamp,
        updatedAt: timestamp,
        state,
        reportBinding: null,
      },
      forbiddenValues,
    );
    writeExclusivePrivateFile(this.absolutePath, bytes);
    this.createdAt = timestamp;
    this.sequence = 0;
  }

  checkpoint({
    state,
    checkpoint,
    forbiddenValues = [],
    reportBinding,
  }: {
    state: TState;
    checkpoint: string;
    forbiddenValues?: Iterable<string | null | undefined>;
    reportBinding?: BasicLifecycleRecoveryReportBinding;
  }) {
    if (this.createdAt === undefined || this.sequence < 0) {
      throw new Error(
        "Recovery capsule file must be created or validated with load() before checkpointing.",
      );
    }
    const current = readBasicLifecycleRecoveryCapsuleFile<TState>(
      this.absolutePath,
    );
    if (
      current.createdAt !== this.createdAt ||
      current.sequence !== this.sequence
    ) {
      throw new Error("Recovery capsule changed outside this harness run.");
    }
    if (
      current.reportBinding &&
      reportBinding &&
      (current.reportBinding.absolutePath !== reportBinding.absolutePath ||
        current.reportBinding.capsuleSha256BeforeBinding !==
          reportBinding.capsuleSha256BeforeBinding ||
        current.reportBinding.reportSha256 !== reportBinding.reportSha256)
    ) {
      throw new Error("Recovery capsule report binding is immutable.");
    }
    const nextSequence = current.sequence + 1;
    const bytes = serializeEncryptedEnvelope(
      {
        kind: BASIC_LIFECYCLE_RECOVERY_CAPSULE_KIND,
        version: BASIC_LIFECYCLE_RECOVERY_CAPSULE_VERSION,
        sequence: nextSequence,
        checkpoint,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
        state,
        reportBinding: reportBinding ?? current.reportBinding,
      },
      forbiddenValues,
    );
    replacePrivateFileAtomically(
      this.absolutePath,
      bytes,
      this.testHooks.beforeAtomicRename,
    );
    this.createdAt = current.createdAt;
    this.sequence = nextSequence;
  }

  sha256() {
    assertSecureRecoveryParent(this.absolutePath);
    assertSecureExistingCapsule(this.absolutePath);
    return sha256BasicLifecycleFile(this.absolutePath);
  }

  bindReport({
    state,
    reportPath,
    reportSha256,
    capsuleSha256BeforeBinding,
    forbiddenValues = [],
  }: {
    state: TState;
    reportPath: string;
    reportSha256: string;
    capsuleSha256BeforeBinding: string;
    forbiddenValues?: Iterable<string | null | undefined>;
  }) {
    if (
      !path.isAbsolute(reportPath) ||
      !SHA256_PATTERN.test(reportSha256) ||
      !SHA256_PATTERN.test(capsuleSha256BeforeBinding)
    ) {
      throw new Error("Recovery capsule report binding is invalid.");
    }
    if (this.sha256() !== capsuleSha256BeforeBinding) {
      throw new Error(
        "Recovery capsule report binding used a stale capsule SHA-256.",
      );
    }
    const normalizedReportPath = path.normalize(reportPath);
    assertSecureArtifactParent(normalizedReportPath);
    assertOwnerPrivateRegularFileStat(
      fs.lstatSync(normalizedReportPath),
      "The recovery report",
    );
    const reportDescriptor = fs.openSync(
      normalizedReportPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      assertOwnerPrivateRegularFileStat(
        fs.fstatSync(reportDescriptor),
        "The opened recovery report",
      );
      (this.testHooks.fsyncReport ?? fs.fsyncSync)(reportDescriptor);
    } finally {
      fs.closeSync(reportDescriptor);
    }
    fsyncDirectory(path.dirname(normalizedReportPath));
    if (this.sha256() !== capsuleSha256BeforeBinding) {
      throw new Error(
        "Recovery capsule changed before its report binding checkpoint.",
      );
    }
    assertOwnerPrivateRegularFileStat(
      fs.lstatSync(normalizedReportPath),
      "The durable recovery report",
    );
    if (sha256BasicLifecycleFile(normalizedReportPath) !== reportSha256) {
      throw new Error(
        "Recovery capsule report binding used a stale report SHA-256.",
      );
    }
    this.checkpoint({
      state,
      checkpoint: "report-written-and-bound",
      forbiddenValues,
      reportBinding: {
        absolutePath: normalizedReportPath,
        capsuleSha256BeforeBinding,
        reportSha256,
      },
    });
  }

  secureUnlink() {
    const parent = assertSecureRecoveryParent(this.absolutePath);
    assertSecureExistingCapsule(this.absolutePath);
    const current = readBasicLifecycleRecoveryCapsuleFile<TState>(
      this.absolutePath,
    );
    if (!current.reportBinding) {
      throw new Error(
        "Recovery capsule cannot be unlinked before a durable report is bound.",
      );
    }
    if (
      this.createdAt !== undefined &&
      (current.createdAt !== this.createdAt ||
        current.sequence !== this.sequence)
    ) {
      throw new Error("Recovery capsule changed outside this harness run.");
    }
    const reportPath = path.normalize(current.reportBinding.absolutePath);
    assertSecureArtifactParent(reportPath);
    assertOwnerPrivateRegularFileStat(
      fs.lstatSync(reportPath),
      "The bound recovery report",
    );
    const reportDescriptor = fs.openSync(
      reportPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      assertOwnerPrivateRegularFileStat(
        fs.fstatSync(reportDescriptor),
        "The opened bound recovery report",
      );
      (this.testHooks.fsyncReport ?? fs.fsyncSync)(reportDescriptor);
    } finally {
      fs.closeSync(reportDescriptor);
    }
    fsyncDirectory(path.dirname(reportPath));
    assertOwnerPrivateRegularFileStat(
      fs.lstatSync(reportPath),
      "The durable bound recovery report",
    );
    if (
      sha256BasicLifecycleFile(reportPath) !==
      current.reportBinding.reportSha256
    ) {
      throw new Error("The bound recovery report SHA-256 does not match.");
    }
    // Re-read the authenticated capsule immediately before deletion so a
    // concurrent checkpoint cannot turn this instance into a stale unlinker.
    const beforeUnlink = readBasicLifecycleRecoveryCapsuleFile<TState>(
      this.absolutePath,
    );
    if (
      beforeUnlink.createdAt !== current.createdAt ||
      beforeUnlink.sequence !== current.sequence ||
      beforeUnlink.reportBinding?.absolutePath !==
        current.reportBinding.absolutePath ||
      beforeUnlink.reportBinding?.reportSha256 !==
        current.reportBinding.reportSha256 ||
      beforeUnlink.reportBinding?.capsuleSha256BeforeBinding !==
        current.reportBinding.capsuleSha256BeforeBinding
    ) {
      throw new Error("Recovery capsule changed before secure unlink.");
    }
    const retainedBytes = fs.readFileSync(this.absolutePath, "utf8");
    fs.unlinkSync(this.absolutePath);
    try {
      this.testHooks.beforeSecureUnlinkDirectoryFsync?.();
      fsyncDirectory(parent);
    } catch (error) {
      // If durability confirmation fails after unlink, restore the exact
      // authenticated capsule before surfacing failure so callers never
      // misreport a missing journal as retained.
      try {
        writeExclusivePrivateFile(this.absolutePath, retainedBytes);
      } catch (restoreError) {
        try {
          assertSecureExistingCapsule(this.absolutePath);
        } catch {
          throw new AggregateError(
            [error, restoreError],
            "Recovery capsule unlink and rollback both failed.",
          );
        }
      }
      throw error;
    }
  }
}
