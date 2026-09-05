import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

import { canonicalizeArcJson } from "./reports.ts";
import type { ArcPreparedReviewInput, ArcReviewLimits } from "./reports.ts";
import { runArcBoundedProcess } from "./process.ts";

interface ArcGitTreeEntry { gitMode: "100644" | "100755"; objectId: string; pathBytes: Uint8Array; size: number; }
interface ArcInputManifest {
  version: 1; baseSha: string; headSha: string; range: string; ignoredPolicy: "excluded";
  source: Array<{ path: string; gitMode: "100644" | "100755"; physicalMode: "0400" | "0500"; size: number; sha256: string }>;
  changes: Array<{ path: string; status: "added" | "modified" | "deleted"; baseObjectId?: string; headObjectId?: string }>;
  materials: Array<{ path: string; physicalMode: "0400"; size: number; sha256: string }>;
}

type ManifestSource = ArcInputManifest["source"][number];
type ManifestMaterial = ArcInputManifest["materials"][number];
const decoder = new TextDecoder("utf-8", { fatal: true });
const GIT_PREFIX = ["-c", "diff.external=", "-c", "diff.trustExitCode=false", "-c", "core.fsmonitor=false"];

function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function boundedMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return Buffer.from(value, "utf8").subarray(0, 4096).toString("utf8");
}
function validateLimits(limits: ArcReviewLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} limit must be a non-negative safe integer`);
  }
}
function decodeText(bytes: Uint8Array, category: string): string {
  try { return decoder.decode(bytes); } catch { throw new Error(`${category} is not valid UTF-8`); }
}
function rawSort(left: string, right: string): number { return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")); }
function splitZ(bytes: Uint8Array, category: string): Uint8Array[] {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) throw new Error(`${category} is missing its NUL terminator`);
  const result: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) if (bytes[index] === 0) {
    if (index === start) throw new Error(`${category} contains an empty record`);
    result.push(bytes.subarray(start, index)); start = index + 1;
  }
  return result;
}

function validateInputPath(value: string, category = "Git path"): void {
  if (!value || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`${category} is absolute or uses an unsupported separator`);
  }
  if (value.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error(`${category} contains a dot or empty segment`);
}

function portableCaselessKey(value: string): string {
  // Unicode upper-then-lower expands multi-character forms and unifies variants
  // such as final sigma without depending on the host filesystem or locale.
  return value.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

function validatePathSet(paths: string[], category: string): void {
  const exact = new Set<string>();
  const normalizedPrefixes = new Map<string, string>();
  const foldedPrefixes = new Map<string, string>();
  for (const value of paths) {
    validateInputPath(value, category);
    if (exact.has(value)) throw new Error(`${category} contains duplicate path: ${value}`);
    exact.add(value);
    const parts = value.split("/");
    for (let length = 1; length <= parts.length; length += 1) {
      const prefix = parts.slice(0, length).join("/");
      const normal = prefix.normalize("NFC");
      const normalizedExisting = normalizedPrefixes.get(normal);
      if (normalizedExisting !== undefined && normalizedExisting !== prefix) throw new Error(`${category} has a Unicode-normalization collision`);
      normalizedPrefixes.set(normal, prefix);
      const fold = portableCaselessKey(normal);
      const foldedExisting = foldedPrefixes.get(fold);
      if (foldedExisting !== undefined && foldedExisting !== prefix) throw new Error(`${category} has a platform case-fold collision`);
      foldedPrefixes.set(fold, prefix);
    }
  }
  const ordered = [...paths].sort(rawSort);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].startsWith(`${ordered[index - 1]}/`)) throw new Error(`${category} has a file/directory collision`);
  }
}

async function runGitBytes(input: { repositoryRoot: string; args: string[]; stdin?: Uint8Array; maxOutputBytes: number; timeoutMs: number }): Promise<Uint8Array> {
  const result = await runArcBoundedProcess({
    command: "git", args: [...GIT_PREFIX, ...input.args], cwd: input.repositoryRoot,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_EXTERNAL_DIFF: "", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    ...(input.stdin ? { stdin: input.stdin } : {}), timeoutMs: input.timeoutMs,
    stopGraceMs: 250, killGraceMs: 1_000, maxOutputBytes: input.maxOutputBytes,
  });
  if (!result.spawned || result.exitCode !== 0 || result.termination !== "observed" || result.timedOut || result.aborted ||
      result.stdoutTruncated || result.stderrTruncated || result.observationError) {
    throw new Error(`Git ${input.args[0] ?? "command"} failed: exit=${result.exitCode ?? "none"}, termination=${result.termination}, ${result.observationError ?? "bounded output/process failure"}`);
  }
  return result.stdout;
}

function parseLsTreeZ(bytes: Uint8Array): ArcGitTreeEntry[] {
  const entries: ArcGitTreeEntry[] = [];
  const paths: string[] = [];
  for (const record of splitZ(bytes, "ls-tree output")) {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error("ls-tree record is missing a path separator");
    const headerBytes = record.subarray(0, tab);
    if ([...headerBytes].some((byte) => byte > 0x7f)) throw new Error("ls-tree record header is not ASCII");
    const header = Buffer.from(headerBytes).toString("ascii");
    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64}) +(\d+|-)$/.exec(header);
    if (!match) throw new Error("ls-tree record header is malformed");
    const [, mode, kind, objectId, declaredSize] = match;
    if ((mode !== "100644" && mode !== "100755") || kind !== "blob" || declaredSize === "-") {
      throw new Error(`unsupported Git mode or object kind: ${mode} ${kind}`);
    }
    const size = Number(declaredSize);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("ls-tree declared size is invalid");
    const pathBytes = Uint8Array.from(record.subarray(tab + 1));
    const value = decodeText(pathBytes, "ls-tree path");
    paths.push(value);
    entries.push({ gitMode: mode, objectId, pathBytes, size });
  }
  validatePathSet(paths, "source tree");
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.pathBytes), Buffer.from(right.pathBytes)));
  return entries;
}

function catResponseSize(entry: ArcGitTreeEntry): number {
  return Buffer.byteLength(`${entry.objectId} blob ${entry.size}\n`, "ascii") + entry.size + 1;
}

function chunkEntriesForBatch(entries: ArcGitTreeEntry[], maxGitOutputBytes: number): ArcGitTreeEntry[][] {
  const chunks: ArcGitTreeEntry[][] = [];
  let current: ArcGitTreeEntry[] = [];
  let size = 0;
  for (const entry of entries) {
    const expected = catResponseSize(entry);
    if (expected > maxGitOutputBytes) throw new Error(`blob response exceeds maxGitOutputBytes: ${decodeText(entry.pathBytes, "source path")}`);
    if (current.length && size + expected > maxGitOutputBytes) { chunks.push(current); current = []; size = 0; }
    current.push(entry); size += expected;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function parseCatFileBatch(bytes: Uint8Array, expected: ArcGitTreeEntry[]): Array<ArcGitTreeEntry & { bytes: Uint8Array }> {
  const result: Array<ArcGitTreeEntry & { bytes: Uint8Array }> = [];
  let cursor = 0;
  for (const entry of expected) {
    let lineEnd = cursor;
    while (lineEnd < bytes.length && bytes[lineEnd] !== 0x0a) lineEnd += 1;
    if (lineEnd >= bytes.length) throw new Error("cat-file batch header is truncated");
    const headerBytes = bytes.subarray(cursor, lineEnd);
    if ([...headerBytes].some((byte) => byte > 0x7f)) throw new Error("cat-file batch header is not ASCII");
    const header = Buffer.from(headerBytes).toString("ascii");
    if (header === `${entry.objectId} missing` || header.endsWith(" missing")) throw new Error(`cat-file reports missing object for ${decodeText(entry.pathBytes, "source path")}`);
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([^ ]+) (\d+)$/.exec(header);
    if (!match || match[1] !== entry.objectId || match[2] !== "blob" || Number(match[3]) !== entry.size) throw new Error("cat-file batch header does not match ls-tree");
    cursor = lineEnd + 1;
    const payloadEnd = cursor + entry.size;
    if (payloadEnd >= bytes.length) throw new Error("cat-file batch payload is truncated");
    const payload = Uint8Array.from(bytes.subarray(cursor, payloadEnd));
    if (bytes[payloadEnd] !== 0x0a) throw new Error("cat-file batch payload separator is missing");
    cursor = payloadEnd + 1;
    result.push({ ...entry, bytes: payload });
  }
  if (cursor !== bytes.length) throw new Error("cat-file batch has trailing data");
  return result;
}

async function writeExclusive(file: string, bytes: Uint8Array, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await fs.open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function exportGitBlobs(input: { repositoryRoot: string; entries: ArcGitTreeEntry[]; destination: string; limits: ArcReviewLimits }): Promise<ManifestSource[]> {
  const rows: ManifestSource[] = [];
  for (const chunk of chunkEntriesForBatch(input.entries, input.limits.maxGitOutputBytes)) {
    const query = Buffer.from(chunk.map((entry) => `${entry.objectId}\n`).join(""), "ascii");
    const batch = await runGitBytes({ repositoryRoot: input.repositoryRoot, args: ["cat-file", "--batch"], stdin: query, maxOutputBytes: input.limits.maxGitOutputBytes, timeoutMs: 30_000 });
    for (const record of parseCatFileBatch(batch, chunk)) {
      const relative = decodeText(record.pathBytes, "source path");
      await writeExclusive(path.join(input.destination, ...relative.split("/")), record.bytes, record.gitMode === "100755" ? 0o700 : 0o600);
      rows.push({ path: relative, gitMode: record.gitMode, physicalMode: record.gitMode === "100755" ? "0500" : "0400", size: record.size, sha256: sha256(record.bytes) });
    }
  }
  return rows;
}

function parseRawChanges(bytes: Uint8Array, maxFiles: number): ArcInputManifest["changes"] {
  const records = splitZ(bytes, "diff-tree output");
  const changes: ArcInputManifest["changes"] = [];
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 2) {
    if (!records[index + 1]) throw new Error("diff-tree change is missing a path");
    const metadataBytes = records[index];
    if ([...metadataBytes].some((byte) => byte > 0x7f)) throw new Error("diff-tree metadata is not ASCII");
    const metadata = Buffer.from(metadataBytes).toString("ascii");
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([AMD])$/.exec(metadata);
    if (!match) throw new Error("diff-tree metadata is malformed or has an unsupported status");
    const [, oldMode, newMode, oldId, newId, letter] = match;
    const zero = "0".repeat(oldId.length);
    if ((oldMode !== "000000" && oldMode !== "100644" && oldMode !== "100755") ||
        (newMode !== "000000" && newMode !== "100644" && newMode !== "100755")) throw new Error("diff-tree contains an unsupported symlink, gitlink, or mode");
    const value = decodeText(records[index + 1], "diff-tree path");
    paths.push(value);
    if (letter === "A") {
      if (oldMode !== "000000" || oldId !== zero || newMode === "000000" || newId === zero) throw new Error("added change metadata is inconsistent");
      changes.push({ path: value, status: "added", headObjectId: newId });
    } else if (letter === "D") {
      if (newMode !== "000000" || newId !== zero || oldMode === "000000" || oldId === zero) throw new Error("deleted change metadata is inconsistent");
      changes.push({ path: value, status: "deleted", baseObjectId: oldId });
    } else {
      if (oldMode === "000000" || newMode === "000000" || oldId === zero || newId === zero) throw new Error("modified change metadata is inconsistent");
      changes.push({ path: value, status: "modified", baseObjectId: oldId, headObjectId: newId });
    }
    if (changes.length > maxFiles) throw new Error("change list exceeds maxFiles limit");
  }
  validatePathSet(paths, "change list");
  return changes.sort((left, right) => rawSort(left.path, right.path));
}

async function validateCommit(repositoryRoot: string, value: string, label: string, limits: ArcReviewLimits): Promise<void> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new Error(`${label} must be a full lowercase commit SHA`);
  let bytes: Uint8Array;
  try {
    bytes = await runGitBytes({ repositoryRoot, args: ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`], maxOutputBytes: limits.maxGitOutputBytes, timeoutMs: 30_000 });
  } catch (error) { throw new Error(`${label} commit cannot be resolved: ${boundedMessage(error)}`); }
  const output = decodeText(bytes, label).replace(/\n$/, "");
  if (output !== value) throw new Error(`${label} does not resolve exactly to the requested commit`);
}

async function requireAncestor(repositoryRoot: string, baseSha: string, headSha: string, limits: ArcReviewLimits): Promise<void> {
  const result = await runArcBoundedProcess({
    command: "git", args: [...GIT_PREFIX, "merge-base", "--is-ancestor", baseSha, headSha], cwd: repositoryRoot,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_EXTERNAL_DIFF: "", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    timeoutMs: 30_000, stopGraceMs: 250, killGraceMs: 1_000, maxOutputBytes: limits.maxGitOutputBytes,
  });
  if (!result.spawned || result.termination !== "observed" || result.timedOut || result.stdoutTruncated || result.stderrTruncated || result.observationError) throw new Error("Git ancestor check failed");
  if (result.exitCode === 1) throw new Error("base commit is not an ancestor of head commit");
  if (result.exitCode !== 0) throw new Error("Git ancestor check failed");
}

async function rejectSymlinkComponents(value: string): Promise<void> {
  const absolute = path.resolve(value);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error(`destination has a symlink component: ${cursor}`);
  }
}
function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function addMaterial(root: string, relative: string, bytes: Uint8Array, limits: ArcReviewLimits): Promise<ManifestMaterial> {
  validateInputPath(relative, "material path");
  if (bytes.length > limits.maxFileBytes) throw new Error(`material exceeds maxFileBytes: ${relative}`);
  await writeExclusive(path.join(root, ...relative.split("/")), bytes, 0o600);
  return { path: relative, physicalMode: "0400", size: bytes.length, sha256: sha256(bytes) };
}

async function finalizeReadOnlyTree(root: string, executableSourcePaths: Set<string>): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => rawSort(left.name, right.name));
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      const stat = await fs.lstat(child);
      if (stat.isSymbolicLink()) throw new Error("staging tree unexpectedly contains a symlink");
      if (stat.isDirectory()) await visit(child);
      else if (stat.isFile()) {
        const relative = path.relative(root, child).split(path.sep).join("/");
        await fs.chmod(child, executableSourcePaths.has(relative) ? 0o500 : 0o400);
        const handle = await fs.open(child, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try { await handle.sync(); } finally { await handle.close(); }
      } else throw new Error("staging tree unexpectedly contains a special file");
    }
    await fs.chmod(directory, 0o500);
    const handle = await fs.open(directory, fsConstants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  };
  await visit(root);
}

function modeString(mode: number): "0400" | "0500" { return (mode & 0o777) === 0o500 ? "0500" : "0400"; }
class InputChangedError extends Error {}

async function readFinalFile(root: string, relative: string, expectedMode: "0400" | "0500", expectedSize: number, expectedDigest: string): Promise<Uint8Array> {
  validateInputPath(relative, "manifest path");
  const file = path.join(root, ...relative.split("/"));
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new InputChangedError(`${relative} is not an ordinary file`);
  if (modeString(stat.mode) !== expectedMode || (stat.mode & 0o777) !== Number.parseInt(expectedMode, 8)) throw new InputChangedError(`${relative} mode changed`);
  if (stat.size !== expectedSize) throw new InputChangedError(`${relative} size changed`);
  if (stat.size > expectedSize) throw new InputChangedError(`${relative} exceeds declared size`);
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Uint8Array;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== expectedSize || (opened.mode & 0o777) !== Number.parseInt(expectedMode, 8)) {
      throw new InputChangedError(`${relative} changed while opening`);
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== opened.size || after.mode !== opened.mode || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new InputChangedError(`${relative} changed while reading`);
    }
  } finally { await handle.close(); }
  const finalStat = await fs.lstat(file);
  if (!finalStat.isFile() || finalStat.dev !== stat.dev || finalStat.ino !== stat.ino || finalStat.size !== stat.size || finalStat.mode !== stat.mode || finalStat.mtimeMs !== stat.mtimeMs || finalStat.ctimeMs !== stat.ctimeMs) {
    throw new InputChangedError(`${relative} changed after reading`);
  }
  if (bytes.length !== expectedSize || sha256(bytes) !== expectedDigest) throw new InputChangedError(`${relative} bytes changed`);
  return bytes;
}

function validateManifest(value: unknown, limits?: ArcReviewLimits): ArcInputManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InputChangedError("manifest is not an object");
  const manifest = value as Partial<ArcInputManifest>;
  if (manifest.version !== 1 || typeof manifest.baseSha !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(manifest.baseSha) ||
      typeof manifest.headSha !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(manifest.headSha) ||
      manifest.range !== `${manifest.baseSha}..${manifest.headSha}` || manifest.ignoredPolicy !== "excluded" ||
      !Array.isArray(manifest.source) || !Array.isArray(manifest.changes) || !Array.isArray(manifest.materials)) throw new InputChangedError("manifest fields are invalid");
  const source = manifest.source as ManifestSource[];
  const materials = manifest.materials as ManifestMaterial[];
  if (limits && (source.length + materials.length + 1 > limits.maxFiles || manifest.changes.length > limits.maxFiles)) throw new InputChangedError("manifest exceeds maxFiles");
  for (const row of source) {
    if (!row || typeof row.path !== "string" || !["100644", "100755"].includes(row.gitMode) || !["0400", "0500"].includes(row.physicalMode) ||
        row.physicalMode !== (row.gitMode === "100755" ? "0500" : "0400") || !Number.isSafeInteger(row.size) || row.size < 0 || !/^[0-9a-f]{64}$/.test(row.sha256)) throw new InputChangedError("manifest source row is invalid");
  }
  for (const row of materials) {
    if (!row || typeof row.path !== "string" || row.physicalMode !== "0400" || !Number.isSafeInteger(row.size) || row.size < 0 || !/^[0-9a-f]{64}$/.test(row.sha256)) throw new InputChangedError("manifest material row is invalid");
  }
  validatePathSet([...source.map((row) => `source/${row.path}`), ...materials.map((row) => row.path), "manifest.json"], "manifest files");
  return manifest as ArcInputManifest;
}

async function listTree(root: string, maxFiles?: number): Promise<{ files: string[]; directories: string[] }> {
  const files: string[] = []; const directories: string[] = [""];
  const visit = async (directory: string) => {
    const entries = await fs.readdir(path.join(root, ...directory.split("/").filter(Boolean)), { withFileTypes: true });
    for (const entry of entries) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      const stat = await fs.lstat(path.join(root, ...relative.split("/")));
      if (stat.isSymbolicLink()) throw new InputChangedError(`input contains symlink: ${relative}`);
      if (stat.isDirectory()) { directories.push(relative); await visit(relative); }
      else if (stat.isFile()) {
        files.push(relative);
        if (maxFiles !== undefined && files.length > maxFiles) throw new InputChangedError("input file count exceeds maxFiles");
      }
      else throw new InputChangedError(`input contains special file: ${relative}`);
    }
  };
  await visit(""); files.sort(rawSort); directories.sort(rawSort); return { files, directories };
}

async function digestFinalInputTree(root: string, manifestRelative = "manifest.json", limits?: ArcReviewLimits): Promise<{ digest: string; fileCount: number; totalBytes: number }> {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new InputChangedError("input root is not an ordinary directory");
  if ((rootStat.mode & 0o777) !== 0o500) throw new InputChangedError("input root mode changed");
  const manifestFile = path.join(root, manifestRelative);
  const manifestStat = await fs.lstat(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || (manifestStat.mode & 0o777) !== 0o400) throw new InputChangedError("manifest mode changed");
  if (limits && manifestStat.size > limits.maxFileBytes) throw new InputChangedError("manifest exceeds maxFileBytes");
  const manifestHandle = await fs.open(manifestFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let manifestBytes: Uint8Array;
  try {
    const opened = await manifestHandle.stat();
    if (!opened.isFile() || opened.dev !== manifestStat.dev || opened.ino !== manifestStat.ino || opened.size !== manifestStat.size || (opened.mode & 0o777) !== 0o400) {
      throw new InputChangedError("manifest changed while opening");
    }
    if (limits && opened.size > limits.maxFileBytes) throw new InputChangedError("manifest exceeds maxFileBytes");
    manifestBytes = await manifestHandle.readFile();
    const after = await manifestHandle.stat();
    if (after.size !== opened.size || after.mode !== opened.mode || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new InputChangedError("manifest changed while reading");
  } finally { await manifestHandle.close(); }
  const finalManifestStat = await fs.lstat(manifestFile);
  if (!finalManifestStat.isFile() || finalManifestStat.dev !== manifestStat.dev || finalManifestStat.ino !== manifestStat.ino || finalManifestStat.size !== manifestStat.size || finalManifestStat.mode !== manifestStat.mode || finalManifestStat.mtimeMs !== manifestStat.mtimeMs || finalManifestStat.ctimeMs !== manifestStat.ctimeMs) {
    throw new InputChangedError("manifest changed after reading");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(decodeText(manifestBytes, "manifest")); } catch (error) { throw new InputChangedError(`manifest JSON is invalid: ${boundedMessage(error)}`); }
  const manifest = validateManifest(parsed, limits);
  const canonical = canonicalizeArcJson(manifest);
  if (!Buffer.from(manifestBytes).equals(Buffer.from(canonical, "utf8"))) throw new InputChangedError("manifest bytes are not canonical");
  const expectedFiles = ["manifest.json", ...manifest.source.map((row) => `source/${row.path}`), ...manifest.materials.map((row) => row.path)].sort(rawSort);
  const expectedDirectories = new Set(["", "source", "materials"]);
  for (const file of expectedFiles) {
    let directory = path.posix.dirname(file);
    while (directory !== ".") { expectedDirectories.add(directory); directory = path.posix.dirname(directory); }
  }
  const actual = await listTree(root, limits?.maxFiles);
  if (canonicalizeArcJson(actual.files) !== canonicalizeArcJson(expectedFiles)) throw new InputChangedError("input file set changed");
  if (canonicalizeArcJson(actual.directories) !== canonicalizeArcJson([...expectedDirectories].sort(rawSort))) throw new InputChangedError("input directory set changed");
  for (const directory of actual.directories) {
    const stat = await fs.lstat(directory ? path.join(root, ...directory.split("/")) : root);
    if ((stat.mode & 0o777) !== 0o500) throw new InputChangedError(`directory mode changed: ${directory || "."}`);
  }
  const hash = createHash("sha256");
  hash.update(`manifest\0${modeString(manifestStat.mode)}\0${manifestBytes.length}\0`, "utf8"); hash.update(manifestBytes);
  let totalBytes = manifestBytes.length;
  for (const row of [...manifest.source.map((item) => ({ ...item, fullPath: `source/${item.path}` })), ...manifest.materials.map((item) => ({ ...item, fullPath: item.path }))].sort((a, b) => rawSort(a.fullPath, b.fullPath))) {
    if (limits && row.size > limits.maxFileBytes) throw new InputChangedError(`${row.fullPath} exceeds maxFileBytes`);
    if (limits && totalBytes + row.size > limits.maxTotalBytes) throw new InputChangedError("input bytes exceed maxTotalBytes");
    const bytes = await readFinalFile(root, row.fullPath, row.physicalMode, row.size, row.sha256);
    hash.update(`\0${row.fullPath}\0${row.physicalMode}\0${row.size}\0`, "utf8"); hash.update(bytes); totalBytes += bytes.length;
  }
  const fileCount = expectedFiles.length;
  if (limits) {
    if (fileCount > limits.maxFiles) throw new InputChangedError("input file count exceeds maxFiles");
    if (totalBytes > limits.maxTotalBytes) throw new InputChangedError("input bytes exceed maxTotalBytes");
    if (manifestBytes.length > limits.maxFileBytes) throw new InputChangedError("manifest exceeds maxFileBytes");
  }
  return { digest: hash.digest("hex"), fileCount, totalBytes };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function removeOwnedStaging(root: string, identity: { dev: number; ino: number }): Promise<void> {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.dev !== identity.dev || rootStat.ino !== identity.ino) {
    throw new Error("staging ownership could not be verified");
  }
  const makeWritable = async (directory: string): Promise<void> => {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("staging tree contains an unowned entry");
    await fs.chmod(directory, 0o700);
    for (const entry of await fs.readdir(directory)) {
      const child = path.join(directory, entry);
      const childStat = await fs.lstat(child);
      if (childStat.isSymbolicLink() || (!childStat.isDirectory() && !childStat.isFile())) throw new Error("staging tree contains an unowned entry");
      if (childStat.isDirectory()) await makeWritable(child);
    }
  };
  await makeWritable(root);
  await fs.rm(root, { recursive: true });
}

export async function prepareArcReviewInput(input: {
  repositoryRoot: string; baseSha: string; headSha: string; destinationRoot: string; taskContext: string;
  designContext: string; reviewContext: string; repositoryInstructions: Array<{ source: string; content: string }>;
  limits: ArcReviewLimits;
}): Promise<ArcPreparedReviewInput> {
  validateLimits(input.limits);
  const repositoryRoot = await fs.realpath(input.repositoryRoot);
  const gitTopLevel = decodeText(await runGitBytes({
    repositoryRoot, args: ["rev-parse", "--show-toplevel"], maxOutputBytes: input.limits.maxGitOutputBytes, timeoutMs: 30_000,
  }), "repository root").replace(/\n$/, "");
  if (!gitTopLevel || await fs.realpath(gitTopLevel) !== repositoryRoot) throw new Error("repositoryRoot must be the Git worktree root");
  await rejectSymlinkComponents(input.destinationRoot);
  const destinationRoot = await fs.realpath(input.destinationRoot);
  if (isWithin(repositoryRoot, destinationRoot) || isWithin(destinationRoot, repositoryRoot)) throw new Error("destinationRoot must be independent of the repository checkout");
  const destinationStat = await fs.lstat(destinationRoot);
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) throw new Error("destinationRoot must be an ordinary directory");

  await validateCommit(repositoryRoot, input.baseSha, "baseSha", input.limits);
  await validateCommit(repositoryRoot, input.headSha, "headSha", input.limits);
  await requireAncestor(repositoryRoot, input.baseSha, input.headSha, input.limits);

  const treeBytes = await runGitBytes({ repositoryRoot, args: ["ls-tree", "-r", "-z", "-l", "--full-tree", input.headSha], maxOutputBytes: input.limits.maxGitOutputBytes, timeoutMs: 30_000 });
  const entries = parseLsTreeZ(treeBytes);
  if (entries.length > input.limits.maxFiles) throw new Error("source tree exceeds maxFiles limit");
  let declaredSourceBytes = 0;
  for (const entry of entries) {
    if (entry.size > input.limits.maxFileBytes) throw new Error(`source file exceeds maxFileBytes: ${decodeText(entry.pathBytes, "source path")}`);
    declaredSourceBytes += entry.size;
    if (declaredSourceBytes > input.limits.maxTotalBytes) throw new Error("source tree exceeds maxTotalBytes limit");
  }
  const changes = parseRawChanges(await runGitBytes({ repositoryRoot, args: ["diff-tree", "-r", "--raw", "-z", "--no-renames", "--no-abbrev", input.baseSha, input.headSha], maxOutputBytes: input.limits.maxGitOutputBytes, timeoutMs: 30_000 }), input.limits.maxFiles);
  const patch = await runGitBytes({ repositoryRoot, args: ["diff", "--binary", "--no-ext-diff", "--no-textconv", input.baseSha, input.headSha, "--"], maxOutputBytes: input.limits.maxGitOutputBytes, timeoutMs: 30_000 });

  const identifier = randomUUID();
  const stagingRoot = path.join(destinationRoot, `.pi-arc-review-stage-${identifier}`);
  const finalRoot = path.join(destinationRoot, `review-input-${identifier}`);
  let stagingIdentity: { dev: number; ino: number } | undefined;
  try {
    await fs.mkdir(stagingRoot, { mode: 0o700 });
    const created = await fs.lstat(stagingRoot);
    if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("exclusive staging directory creation failed");
    stagingIdentity = { dev: created.dev, ino: created.ino };
    const stagingSource = path.join(stagingRoot, "source");
    await fs.mkdir(stagingSource, { mode: 0o700 });
    const source = await exportGitBlobs({ repositoryRoot, entries, destination: stagingSource, limits: input.limits });
    const materials: ManifestMaterial[] = [];
    materials.push(await addMaterial(stagingRoot, "materials/diff.patch", patch, input.limits));
    materials.push(await addMaterial(stagingRoot, "materials/task.md", Buffer.from(input.taskContext, "utf8"), input.limits));
    materials.push(await addMaterial(stagingRoot, "materials/design.md", Buffer.from(input.designContext, "utf8"), input.limits));
    materials.push(await addMaterial(stagingRoot, "materials/review.md", Buffer.from(input.reviewContext, "utf8"), input.limits));
    for (let index = 0; index < input.repositoryInstructions.length; index += 1) {
      const instruction = input.repositoryInstructions[index];
      if (typeof instruction.source !== "string" || !instruction.source || instruction.source.includes("\0") || typeof instruction.content !== "string") throw new Error("repository instruction is invalid");
      materials.push(await addMaterial(stagingRoot, `materials/instructions/${String(index + 1).padStart(4, "0")}.md`, Buffer.from(instruction.content, "utf8"), input.limits));
    }
    materials.sort((left, right) => rawSort(left.path, right.path));
    validatePathSet(materials.map((row) => row.path), "materials");
    const manifest: ArcInputManifest = { version: 1, baseSha: input.baseSha, headSha: input.headSha, range: `${input.baseSha}..${input.headSha}`, ignoredPolicy: "excluded", source, changes, materials };
    const manifestBytes = Buffer.from(canonicalizeArcJson(manifest), "utf8");
    if (manifestBytes.length > input.limits.maxFileBytes) throw new Error("manifest exceeds maxFileBytes limit");
    await writeExclusive(path.join(stagingRoot, "manifest.json"), manifestBytes, 0o600);
    const executable = new Set(source.filter((row) => row.gitMode === "100755").map((row) => `source/${row.path}`));
    await finalizeReadOnlyTree(stagingRoot, executable);
    const finalDigest = await digestFinalInputTree(stagingRoot, "manifest.json", input.limits);
    await fs.lstat(finalRoot).then(
      () => { throw new Error("exclusive final input path already exists"); },
      (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; },
    );
    await fs.rename(stagingRoot, finalRoot); stagingIdentity = undefined;
    await syncDirectory(destinationRoot);
    return {
      inputRoot: finalRoot, sourceRoot: path.join(finalRoot, "source"), manifestPath: path.join(finalRoot, "manifest.json"),
      diffPath: path.join(finalRoot, "materials", "diff.patch"), digest: finalDigest.digest,
      fileCount: finalDigest.fileCount, totalBytes: finalDigest.totalBytes,
    };
  } catch (error) {
    if (stagingIdentity) {
      try { await removeOwnedStaging(stagingRoot, stagingIdentity); }
      catch (cleanupError) { throw new Error(`${boundedMessage(error)}; staging cleanup failed: ${boundedMessage(cleanupError)}`); }
    }
    throw error;
  }
}

export async function verifyArcReviewInput(prepared: ArcPreparedReviewInput, limits: ArcReviewLimits): Promise<{ state: "unchanged" | "changed" | "unreadable"; differences: string[] }> {
  try {
    validateLimits(limits);
    if (prepared.sourceRoot !== path.join(prepared.inputRoot, "source") || prepared.manifestPath !== path.join(prepared.inputRoot, "manifest.json") || prepared.diffPath !== path.join(prepared.inputRoot, "materials", "diff.patch")) {
      return { state: "changed", differences: ["prepared paths changed"] };
    }
    const actual = await digestFinalInputTree(prepared.inputRoot, "manifest.json", limits);
    const differences: string[] = [];
    if (actual.digest !== prepared.digest) differences.push("input digest changed");
    if (actual.fileCount !== prepared.fileCount) differences.push("input file count changed");
    if (actual.totalBytes !== prepared.totalBytes) differences.push("input total bytes changed");
    return differences.length ? { state: "changed", differences } : { state: "unchanged", differences: [] };
  } catch (error) {
    if (error instanceof InputChangedError) return { state: "changed", differences: [boundedMessage(error)] };
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !await fs.lstat(prepared.inputRoot).then(() => true, () => false)) return { state: "unreadable", differences: ["input root is unreadable"] };
    return { state: code === "EACCES" || code === "EPERM" ? "unreadable" : "changed", differences: [boundedMessage(error)] };
  }
}
