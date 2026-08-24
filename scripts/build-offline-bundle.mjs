#!/usr/bin/env node
/**
 * Builds the offline full bundle from the exact local release-candidate tgz
 * plus the production dependency tree pinned by package-lock.json.
 *
 * Usage:
 *   node scripts/build-offline-bundle.mjs
 *   node scripts/build-offline-bundle.mjs --tarball ./stinky-cobbler-2.0.1.tgz
 *   node scripts/build-offline-bundle.mjs --out ./stinky-cobbler-2.0.1-offline-full.zip
 *
 * This command never substitutes an already-published registry copy of the
 * package for the candidate being verified. Network access is used only once
 * at build time to install the lockfile-pinned production dependencies.
 */
import { createHash } from "node:crypto";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OFFLINE_LAUNCHERS } from "./offline-bundle-contract.mjs";
import {
  createZipFromDirectory,
  execPortableSync,
  extractNpmTarballSafe,
  isDirectInvocation,
  npmExecutable,
  removeNonRuntimeBin
} from "./release-utils.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildOfflineBundle(options = {}) {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageLockPath = path.join(projectRoot, "package-lock.json");
  const packageJsonBytes = await readFile(packageJsonPath);
  const packageLockBytes = await readFile(packageLockPath);
  const pkg = JSON.parse(packageJsonBytes.toString("utf8"));
  if (pkg.name !== "stinky-cobbler" || typeof pkg.version !== "string") throw new Error("package.json does not describe a valid stinky-cobbler release.");

  const tarball = path.resolve(projectRoot, options.tarball ?? `stinky-cobbler-${pkg.version}.tgz`);
  const zipPath = path.resolve(projectRoot, options.out ?? `stinky-cobbler-${pkg.version}-offline-full.zip`);
  const tarballInfo = await lstat(tarball);
  if (!tarballInfo.isFile()) throw new Error("The release-candidate tarball must be a regular file.");

  const work = await mkdtemp(path.join(os.tmpdir(), "sc-offline-"));
  // Generate the archive beside its final destination, then publish the
  // completed inode with an exclusive hard link. This makes publication
  // no-clobber and race-safe for existing files and dangling symlinks.
  const publishWork = await mkdtemp(path.join(path.dirname(zipPath), ".sc-offline-publish-"));
  const bundleName = `stinky-cobbler-${pkg.version}-offline-full`;
  const outDir = path.join(work, bundleName);
  const temporaryZip = path.join(publishWork, path.basename(zipPath));
  const dependenciesDir = path.join(work, "locked-production-dependencies");
  const binDir = path.join(outDir, "bin");
  const npmCacheDir = path.join(outDir, "npm-cache");
  try {
    await mkdir(binDir, { recursive: true });
    await mkdir(dependenciesDir);
    await mkdir(npmCacheDir);
    await copyFile(packageJsonPath, path.join(dependenciesDir, "package.json"));
    await copyFile(packageLockPath, path.join(dependenciesDir, "package-lock.json"));
    execPortableSync(npmExecutable(), [
      "ci", "--prefix", dependenciesDir, "--omit=dev", "--ignore-scripts",
      "--registry=https://registry.npmjs.org", "--cache", npmCacheDir
    ], {
      stdio: "inherit",
      cwd: work
    });
    await Promise.all([
      rm(path.join(npmCacheDir, "_logs"), { recursive: true, force: true }),
      rm(path.join(npmCacheDir, "_update-notifier-last-checked"), { force: true })
    ]);

    // npm tarballs contain one top-level `package/` directory.
    await extractNpmTarballSafe(tarball, outDir);
    const packedPackagePath = path.join(outDir, "package", "package.json");
    const packedPackage = JSON.parse(await readFile(packedPackagePath, "utf8"));
    if (packedPackage.name !== pkg.name || packedPackage.version !== pkg.version) {
      throw new Error("The candidate tarball name/version does not match package.json.");
    }

    await removeNonRuntimeBin(path.join(dependenciesDir, "node_modules"));
    await rename(path.join(dependenciesDir, "node_modules"), path.join(outDir, "node_modules"));
    // Retain the exact manifests used by npm ci so consumers can audit the
    // bundled production tree with `npm ls --omit=dev --all` while offline.
    await copyFile(packageJsonPath, path.join(outDir, "package.json"));
    await copyFile(packageLockPath, path.join(outDir, "package-lock.json"));

    for (const [relative, launcher] of Object.entries(OFFLINE_LAUNCHERS)) {
      const destination = path.join(outDir, ...relative.split("/"));
      await writeFile(destination, launcher.contents, "utf8");
      if (launcher.executable) await chmod(destination, 0o755);
    }

    const canonicalManual = path.join(outDir, "package", "docs", "quickstart", "使用说明书.md");
    await copyFile(canonicalManual, path.join(outDir, "使用说明书.md"));
    await writeFile(path.join(outDir, "bundle-manifest.json"), `${JSON.stringify({
      version: 2,
      package: {
        name: pkg.name,
        version: pkg.version,
        tarball: path.basename(tarball),
        sha256: sha256(await readFile(tarball))
      },
      packageLockSha256: sha256(packageLockBytes),
      dependencyVerification: "canonical-lockfile-sri-offline-npm-ci-tree-v1",
      node: pkg.engines?.node ?? ">=22.0.0"
    }, null, 2)}\n`, "utf8");
    await writeFile(path.join(outDir, "README.txt"), offlineBundleReadme(pkg.version), "utf8");

    // npm ci already guarantees lockfile installation; this catches a move or
    // packaging regression before the zip becomes a release artifact.
    try {
      execPortableSync(npmExecutable(), ["ls", "--prefix", outDir, "--omit=dev", "--all", "--json"], {
        stdio: "pipe",
        cwd: work,
        encoding: "utf8",
        env: { ...process.env, npm_config_offline: "true" }
      });
    } catch {
      throw new Error("The lockfile-pinned production dependency tree failed npm ls validation.");
    }
    await createZipFromDirectory(outDir, temporaryZip, bundleName);
    const archiveHash = sha256(await readFile(temporaryZip));
    await publishExclusive(temporaryZip, zipPath);
    return { valid: true, version: pkg.version, tarball, out: zipPath, sha256: archiveHash };
  } finally {
    await Promise.all([
      rm(work, { recursive: true, force: true }),
      rm(publishWork, { recursive: true, force: true })
    ]);
  }
}

/** Human-facing safe installation sequence embedded in every offline bundle. */
export function offlineBundleReadme(version) {
  return [
    `Stinky Cobbler ${version} offline bundle (no network required at use time)`,
    "",
    "Requirements: Node.js >= 22 (any OS).",
    "This bundle contains the exact local candidate package, production dependencies pinned by package-lock.json, and an independent npm cache.",
    "Release verification rebuilds dependencies with npm ci --offline from the canonical lockfile SRI and compares every runtime dependency file.",
    "",
    "macOS / Linux:",
    "  export PATH=\"$PWD/bin:$PATH\"   # from this directory",
    "  stinky-cobbler --version",
    "",
    "Windows (cmd):",
    "  set PATH=%CD%\\bin;%PATH%",
    "  stinky-cobbler --version",
    "",
    "Connecting a host changes host configuration. Follow all three steps:",
    "",
    "1. Preview only (writes nothing):",
    "  stinky-cobbler entry install-host --mcp --dry-run                # ZCode",
    "  stinky-cobbler entry install-host --host codex --mcp --dry-run   # Codex",
    "",
    "2. Review every reported target and explicitly confirm that you want those writes.",
    "",
    "3. Only after that confirmation, install:",
    "  stinky-cobbler entry install-host --mcp                          # ZCode",
    "  stinky-cobbler entry install-host --host codex --mcp             # Codex",
    "",
    "Side effects: install-host writes the host skill and, for ZCode, its command file; --mcp merges an MCP entry into the current host config. Managed-state sidecars are written, and a verified byte-for-byte backup may be created during a managed upgrade. Existing user-edited files are preserved as conflicts rather than overwritten. Rollback is a separate explicit --rollback operation.",
    "",
    "Full manual: see 使用说明书.md in this directory."
  ].join("\n");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Publishes a completed file without ever replacing an existing path. */
export async function publishExclusive(source, target) {
  try {
    await link(source, target);
  } catch (error) {
    if (isCode(error, "EEXIST")) {
      throw new Error(`Refusing to overwrite an existing offline bundle: ${target}`, { cause: error });
    }
    throw error;
  }
}

function isCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if ((argument === "--tarball" || argument === "--out") && typeof value === "string" && !value.startsWith("--")) {
      result[argument === "--tarball" ? "tarball" : "out"] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${String(argument)}`);
  }
  return result;
}

if (isDirectInvocation(import.meta.url)) {
  console.log(JSON.stringify(await buildOfflineBundle(parseArgs(process.argv.slice(2))), null, 2));
}
