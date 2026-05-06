#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const [, , packageName, ...publishExtraArgs] = process.argv;

if (!packageName) {
  console.error("Usage: npm-publish-workspace-if-needed.mjs <workspace-package-name> [npm-publish-extra-args...]");
  process.exit(2);
}

const rootDir = process.cwd();
const npmCommand = process.env.NPM_PUBLISH_IF_NEEDED_NPM ?? "npm";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseNpmJsonValue(stdout) {
  const value = stdout.trim();
  if (!value) return "";

  try {
    return JSON.parse(value);
  } catch {
    return value.replace(/^"|"$/g, "");
  }
}

function parseSemver(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported semver version: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifiers(left, right) {
  const leftIsNumeric = /^\d+$/.test(left);
  const rightIsNumeric = /^\d+$/.test(right);

  if (leftIsNumeric && rightIsNumeric) {
    return Number(left) - Number(right);
  }

  if (leftIsNumeric) return -1;
  if (rightIsNumeric) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];

    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;

    const comparison = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (comparison !== 0) return comparison;
  }

  return 0;
}

function compareSemver(left, right) {
  const leftVersion = parseSemver(left);
  const rightVersion = parseSemver(right);

  for (const key of ["major", "minor", "patch"]) {
    if (leftVersion[key] !== rightVersion[key]) {
      return leftVersion[key] - rightVersion[key];
    }
  }

  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function isPrerelease(version) {
  return parseSemver(version).prerelease.length > 0;
}

function publishDistTag(args) {
  let tag = "latest";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--tag" && args[index + 1]) {
      tag = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--tag=")) {
      tag = arg.slice("--tag=".length);
    }
  }
  return tag;
}

function expandWorkspacePattern(pattern) {
  if (!pattern.endsWith("/*")) {
    return [pattern];
  }

  const parent = pattern.slice(0, -2);
  const parentPath = join(rootDir, parent);
  if (!existsSync(parentPath)) {
    return [];
  }

  return readdirSync(parentPath)
    .map((entry) => join(parent, entry))
    .filter((workspacePath) => {
      const absolutePath = join(rootDir, workspacePath);
      return statSync(absolutePath).isDirectory() && existsSync(join(absolutePath, "package.json"));
    });
}

function findWorkspacePackage(name) {
  const rootPackage = readJson(join(rootDir, "package.json"));
  const workspaces = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : rootPackage.workspaces?.packages;

  if (!Array.isArray(workspaces)) {
    throw new Error("Root package.json does not declare npm workspaces");
  }

  for (const workspacePattern of workspaces) {
    for (const workspacePath of expandWorkspacePattern(workspacePattern)) {
      const packagePath = join(rootDir, workspacePath, "package.json");
      const pkg = readJson(packagePath);
      if (pkg.name === name) {
        return { packagePath, workspacePath, pkg };
      }
    }
  }

  throw new Error(`Workspace package not found: ${name}`);
}

function runNpm(args) {
  return spawnSync(npmCommand, args, {
    cwd: rootDir,
    encoding: "utf8",
  });
}

function isNpmNotFound(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return /\bE404\b|404 Not Found|No match found for version/i.test(output);
}

const { workspacePath, pkg } = findWorkspacePackage(packageName);
const versionSpecifier = `${pkg.name}@${pkg.version}`;
const distTag = publishDistTag(publishExtraArgs);

console.log(`Checking npm for ${versionSpecifier} from ${workspacePath}`);
const exactVersionResult = runNpm(["view", versionSpecifier, "version", "--json"]);

if (exactVersionResult.status === 0) {
  const publishedVersion = parseNpmJsonValue(exactVersionResult.stdout);
  console.log(`${versionSpecifier} is already published${publishedVersion ? ` as ${publishedVersion}` : ""}; skipping npm publish.`);
  process.exit(0);
}

if (!isNpmNotFound(exactVersionResult)) {
  process.stdout.write(exactVersionResult.stdout ?? "");
  process.stderr.write(exactVersionResult.stderr ?? "");
  process.exit(exactVersionResult.status ?? 1);
}

if (distTag === "latest" && isPrerelease(pkg.version)) {
  console.error(`${versionSpecifier} is a prerelease; refusing to publish it with the default latest dist-tag. Pass --tag <non-latest-tag> for intentional prerelease publishing.`);
  process.exit(1);
}

if (distTag === "latest") {
  const latestVersionResult = runNpm(["view", pkg.name, "version", "--json"]);
  if (latestVersionResult.status === 0) {
    const latestVersion = parseNpmJsonValue(latestVersionResult.stdout);
    if (latestVersion && compareSemver(latestVersion, pkg.version) > 0) {
      console.error(
        `${versionSpecifier} is older than the npm latest ${pkg.name}@${latestVersion}; refusing to publish because npm would move the latest dist-tag backwards.`,
      );
      process.exit(1);
    }
  } else if (!isNpmNotFound(latestVersionResult)) {
    process.stdout.write(latestVersionResult.stdout ?? "");
    process.stderr.write(latestVersionResult.stderr ?? "");
    process.exit(latestVersionResult.status ?? 1);
  }
}

console.log(`${versionSpecifier} is not published yet; running npm publish.`);
const publishResult = spawnSync(
  npmCommand,
  ["publish", "--workspace", pkg.name, "--access", "public", "--provenance", ...publishExtraArgs],
  {
    cwd: rootDir,
    stdio: "inherit",
  },
);

process.exit(publishResult.status ?? 1);
