import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

import { canonicalizeArcJson } from "./reports.ts";
import type { ArcPrimaryBaseline, ArcReviewLimits } from "./reports.ts";
import { runArcBoundedProcess } from "./process.ts";

const decoder = new TextDecoder("utf-8", { fatal: true });
const GIT_PREFIX = ["-c", "diff.external=", "-c", "diff.trustExitCode=false", "-c", "core.fsmonitor=false"];

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function diagnostic(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return Buffer.from(text, "utf8").subarray(0, 4096).toString("utf8");
}

function validateLimits(limits: ArcReviewLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} limit must be a non-negative safe integer`);
  }
}

async function runGit(repositoryRoot: string, args: string[], limits: ArcReviewLimits, allowedCodes: number[] = [0]) {
  const result = await runArcBoundedProcess({
    command: "git", args: [...GIT_PREFIX, ...args], cwd: repositoryRoot,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_EXTERNAL_DIFF: "", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    timeoutMs: 30_000, stopGraceMs: 250, killGraceMs: 1_000, maxOutputBytes: limits.maxGitOutputBytes,
  });
  if (!result.spawned || result.termination !== "observed" || result.timedOut || result.aborted ||
      result.stdoutTruncated || result.stderrTruncated || !allowedCodes.includes(result.exitCode ?? -1) || result.observationError) {
    throw new Error(`Git ${args[0] ?? "command"} failed (${result.exitCode ?? "no exit"}; ${result.observationError ?? "bounded failure"})`);
  }
  return result;
}

function decodeText(bytes: Uint8Array, category: string): string {
  try { return decoder.decode(bytes); }
  catch { throw new Error(`${category} was not valid UTF-8`); }
}

function oneLine(bytes: Uint8Array, category: string): string {
  return decodeText(bytes, category).replace(/\n$/, "");
}

function validateRelativePath(value: string, category: string): void {
  if (!value || value.includes("\0") || path.posix.isAbsolute(value) || value.includes("\\")) throw new Error(`${category} has an unsupported path`);
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error(`${category} has an unsupported path segment`);
}

function splitZ(bytes: Uint8Array, category: string): Uint8Array[] {
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0) throw new Error(`${category} missing NUL terminator`);
  const records: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) {
      if (index === start) throw new Error(`${category} contains an empty record`);
      records.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  return records;
}

function parseIndexedPaths(bytes: Uint8Array): string[] {
  const result: string[] = [];
  for (const record of splitZ(bytes, "index entries")) {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error("index entry missing path separator");
    const metadata = Buffer.from(record.subarray(0, tab)).toString("ascii");
    if (!/^[0-7]{6} [0-9a-f]{40,64} [0-3]$/.test(metadata)) throw new Error("index entry metadata is malformed");
    const value = decodeText(record.subarray(tab + 1), "indexed path");
    validateRelativePath(value, "indexed path");
    result.push(value);
  }
  return result;
}

function parseUntrackedPaths(bytes: Uint8Array): string[] {
  return splitZ(bytes, "untracked entries").map((record) => {
    const value = decodeText(record, "untracked path");
    validateRelativePath(value, "untracked path");
    return value;
  });
}

function rawPathSort(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function physicalMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

async function hasMissingOrRejectSymlinkAncestors(root: string, relativePath: string): Promise<boolean> {
  const parts = relativePath.split("/");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try { stat = await fs.lstat(cursor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw new Error(`cannot lstat ancestor of ${relativePath}: ${(error as NodeJS.ErrnoException).code ?? "filesystem error"}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`filesystem path has symlink ancestor: ${relativePath}`);
    if (!stat.isDirectory()) throw new Error(`filesystem path has non-directory ancestor: ${relativePath}`);
  }
  return false;
}

async function readDeclaredBytes(handle: Awaited<ReturnType<typeof fs.open>>, size: number, label: string): Promise<Uint8Array> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const length = Math.min(64 * 1024, size - offset);
    const result = await handle.read(bytes, offset, length, offset);
    if (result.bytesRead !== length) throw new Error(`file changed while reading: ${label}`);
    offset += length;
  }
  const probe = Buffer.alloc(1);
  if ((await handle.read(probe, 0, 1, size)).bytesRead !== 0) throw new Error(`file changed while reading: ${label}`);
  return bytes;
}

async function readOrdinaryFile(
  file: string,
  before: Awaited<ReturnType<typeof fs.lstat>>,
  maxFileBytes: number,
  remainingTotalBytes: number,
): Promise<Uint8Array> {
  const label = path.basename(file);
  if (before.size > maxFileBytes) throw new Error(`file size exceeds maxFileBytes: ${label}`);
  if (before.size > remainingTotalBytes) throw new Error(`file size exceeds remaining maxTotalBytes: ${label}`);
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size ||
        opened.mode !== before.mode || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) {
      throw new Error(`file changed while opening: ${label}`);
    }
    if (opened.size > maxFileBytes) throw new Error(`file size exceeds maxFileBytes: ${label}`);
    if (opened.size > remainingTotalBytes) throw new Error(`file size exceeds remaining maxTotalBytes: ${label}`);
    const bytes = await readDeclaredBytes(handle, opened.size, label);
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.mode !== opened.mode || bytes.length !== after.size) {
      throw new Error(`file changed while reading: ${label}`);
    }
    const finalStat = await fs.lstat(file);
    if (!finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.dev !== opened.dev || finalStat.ino !== opened.ino ||
        finalStat.size !== opened.size || finalStat.mode !== opened.mode || finalStat.mtimeMs !== opened.mtimeMs || finalStat.ctimeMs !== opened.ctimeMs) {
      throw new Error(`file changed after reading: ${label}`);
    }
    return bytes;
  } finally { await handle.close(); }
}

async function scanPath(root: string, relativePath: string, maxFileBytes: number, remainingTotalBytes: number, missingAllowed: boolean) {
  const missingAncestor = await hasMissingOrRejectSymlinkAncestors(root, relativePath);
  if (missingAncestor) {
    if (missingAllowed) return { path: relativePath, kind: "missing" as const };
    throw new Error(`untracked path disappeared during capture: ${relativePath}`);
  }
  const file = path.join(root, ...relativePath.split("/"));
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try { stat = await fs.lstat(file); }
  catch (error) {
    if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return { path: relativePath, kind: "missing" as const };
    throw new Error(`cannot lstat ${relativePath}: ${(error as NodeJS.ErrnoException).code ?? "filesystem error"}`);
  }
  const mode = physicalMode(stat.mode);
  if (stat.isSymbolicLink()) {
    const targetBytes = await fs.readlink(file, { encoding: "buffer" });
    if (targetBytes.length > maxFileBytes) throw new Error(`symlink target exceeds maxFileBytes: ${relativePath}`);
    if (targetBytes.length > remainingTotalBytes) throw new Error(`symlink target exceeds remaining maxTotalBytes: ${relativePath}`);
    const target = decodeText(targetBytes, `symlink target for ${relativePath}`);
    const after = await fs.lstat(file);
    if (!after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs) throw new Error(`symlink changed while reading: ${relativePath}`);
    return { path: relativePath, mode, kind: "symlink" as const, target };
  }
  if (!stat.isFile()) throw new Error(`unsupported filesystem kind: ${relativePath}`);
  const bytes = await readOrdinaryFile(file, stat, maxFileBytes, remainingTotalBytes);
  return { path: relativePath, mode, kind: "file" as const, sha256: digest(bytes), byteSize: bytes.length };
}

async function readIndex(repositoryRoot: string, limits: ArcReviewLimits): Promise<{ bytes: Uint8Array; path: string }> {
  const result = await runGit(repositoryRoot, ["rev-parse", "--git-path", "index"], limits);
  const named = oneLine(result.stdout, "index path");
  if (!named || named.includes("\0")) throw new Error("Git returned an invalid index path");
  const indexPath = path.isAbsolute(named) ? named : path.resolve(repositoryRoot, named);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try { stat = await fs.lstat(indexPath); }
  catch (error) { throw new Error(`index is unreadable: ${(error as NodeJS.ErrnoException).code ?? "filesystem error"}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("index is not an ordinary file");
  const bytes = await readOrdinaryFile(indexPath, stat, limits.maxFileBytes, limits.maxTotalBytes);
  return { bytes, path: indexPath };
}

async function scanPrimaryState(repositoryRoot: string, reviewedRefs: string[], limits: ArcReviewLimits): Promise<ArcPrimaryBaseline> {
  validateLimits(limits);
  const root = await fs.realpath(repositoryRoot);
  const top = oneLine((await runGit(root, ["rev-parse", "--show-toplevel"], limits)).stdout, "repository root");
  if (await fs.realpath(top) !== root) throw new Error("repositoryRoot must be the Git worktree root");

  const symbolicResult = await runGit(root, ["symbolic-ref", "-q", "HEAD"], limits, [0, 1]);
  const symbolicHead = symbolicResult.exitCode === 0 ? oneLine(symbolicResult.stdout, "symbolic HEAD") : null;
  const headSha = oneLine((await runGit(root, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"], limits)).stdout, "HEAD");
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(headSha)) throw new Error("HEAD did not resolve to a full object ID");

  const resolveRef = async (name: string) => {
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(name)) {
      const objectId = oneLine((await runGit(root, ["rev-parse", "--verify", "--end-of-options", `${name}^{object}`], limits)).stdout, "reviewed SHA");
      if (objectId !== name) throw new Error("reviewed SHA did not resolve exactly");
      return { name, objectId };
    }
    if (!name.startsWith("refs/") || name.includes("\0") || name.startsWith("-")) throw new Error("reviewed ref name is invalid");
    try { await runGit(root, ["check-ref-format", name], limits); }
    catch { throw new Error("reviewed ref name is invalid"); }
    const objectId = oneLine((await runGit(root, ["show-ref", "--verify", "--hash", name], limits)).stdout, "reviewed ref");
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(objectId)) throw new Error("reviewed ref did not resolve to a full object ID");
    return { name, objectId };
  };
  if (new Set(reviewedRefs).size !== reviewedRefs.length) throw new Error("reviewed refs contain duplicates");
  const resolvedReviewed = [];
  for (const ref of [...reviewedRefs].sort(rawPathSort)) resolvedReviewed.push(await resolveRef(ref));
  const activeRef = symbolicHead ? await resolveRef(symbolicHead) : null;
  if (activeRef && activeRef.objectId !== headSha) throw new Error("HEAD and its active ref changed during scan");
  for (const reviewed of resolvedReviewed) {
    if (activeRef && reviewed.name === activeRef.name && reviewed.objectId !== activeRef.objectId) throw new Error("reviewed and active ref changed during scan");
  }

  const index = await readIndex(root, limits);
  const entriesBytes = (await runGit(root, ["ls-files", "--stage", "-z"], limits)).stdout;
  const indexedPaths = parseIndexedPaths(entriesBytes);
  const trackedPaths = [...new Set(indexedPaths)].sort(rawPathSort);
  const untrackedBytes = (await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], limits)).stdout;
  const untrackedPaths = parseUntrackedPaths(untrackedBytes).sort(rawPathSort);
  if (new Set(untrackedPaths).size !== untrackedPaths.length) throw new Error("untracked paths contain duplicates");
  if (trackedPaths.length + untrackedPaths.length > limits.maxFiles) throw new Error("primary file count exceeds maxFiles limit");

  const tracked: ArcPrimaryBaseline["tracked"] = [];
  const untracked: ArcPrimaryBaseline["untracked"] = [];
  let remainingTotalBytes = limits.maxTotalBytes;
  const consume = (size: number) => {
    if (size > remainingTotalBytes) throw new Error("primary byte count exceeds maxTotalBytes limit");
    remainingTotalBytes -= size;
  };
  consume(index.bytes.length);
  consume(entriesBytes.length);
  for (const name of trackedPaths) {
    const row = await scanPath(root, name, limits.maxFileBytes, remainingTotalBytes, true);
    if ("byteSize" in row) consume(row.byteSize);
    else if (row.kind === "symlink") consume(Buffer.byteLength(row.target, "utf8"));
    const { byteSize: _byteSize, ...publicRow } = row as typeof row & { byteSize?: number };
    tracked.push(publicRow);
  }
  for (const name of untrackedPaths) {
    const row = await scanPath(root, name, limits.maxFileBytes, remainingTotalBytes, false);
    if (row.kind === "missing") throw new Error(`untracked path disappeared during capture: ${name}`);
    if ("byteSize" in row) consume(row.byteSize);
    else consume(Buffer.byteLength(row.target, "utf8"));
    const { byteSize: _byteSize, ...publicRow } = row as typeof row & { byteSize?: number };
    untracked.push(publicRow);
  }

  const unsigned = {
    version: 1 as const, repositoryRoot: root, symbolicHead, headSha, activeRef,
    reviewedRefs: resolvedReviewed, index: { sha256: digest(index.bytes), size: index.bytes.length, entriesSha256: digest(entriesBytes) },
    tracked, untracked, ignoredPolicy: "excluded" as const,
  };
  return { ...unsigned, digest: digest(canonicalizeArcJson(unsigned)) };
}

export async function captureArcPrimaryBaseline(input: { repositoryRoot: string; reviewedRefs: string[]; limits: ArcReviewLimits }): Promise<ArcPrimaryBaseline> {
  const first = await scanPrimaryState(input.repositoryRoot, input.reviewedRefs, input.limits);
  const second = await scanPrimaryState(input.repositoryRoot, input.reviewedRefs, input.limits);
  if (first.digest !== second.digest) throw new Error("primary baseline changed during capture");
  return first;
}

export async function compareArcPrimaryBaseline(expected: ArcPrimaryBaseline, limits: ArcReviewLimits): Promise<{ state: "unchanged" | "changed" | "unreadable"; differences: string[]; actualDigest?: string }> {
  try {
    const actual = await captureArcPrimaryBaseline({ repositoryRoot: expected.repositoryRoot, reviewedRefs: expected.reviewedRefs.map((row) => row.name), limits });
    if (actual.digest === expected.digest) return { state: "unchanged", differences: [], actualDigest: actual.digest };
    const differences: string[] = [];
    for (const field of ["repositoryRoot", "symbolicHead", "headSha", "activeRef", "reviewedRefs", "index", "tracked", "untracked", "ignoredPolicy"] as const) {
      if (canonicalizeArcJson(actual[field]) !== canonicalizeArcJson(expected[field])) differences.push(`${field} changed`);
    }
    return { state: "changed", differences, actualDigest: actual.digest };
  } catch (error) {
    return { state: "unreadable", differences: [`primary state unreadable: ${diagnostic(error)}`] };
  }
}
