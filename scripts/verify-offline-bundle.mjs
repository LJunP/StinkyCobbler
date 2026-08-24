import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OFFLINE_LAUNCHERS } from "./offline-bundle-contract.mjs";
import {
  directoryFingerprint,
  execPortableSync,
  extractNpmTarballSafe,
  extractZipSafe,
  isDirectInvocation,
  npmExecutable,
  removeNonRuntimeBin,
  windowsCmdInvocation
} from "./release-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Extracts and verifies one offline release bundle without network access. */
export async function verifyOfflineBundle(file, sourceRoot = root) {
  const problems = [];
  const packageJsonBytes = await readFile(path.join(sourceRoot, "package.json"));
  const packageLockBytes = await readFile(path.join(sourceRoot, "package-lock.json"));
  const packageJson = JSON.parse(packageJsonBytes.toString("utf8"));
  const bundleName = `stinky-cobbler-${packageJson.version}-offline-full`;
  const candidateTarball = path.join(sourceRoot, `stinky-cobbler-${packageJson.version}.tgz`);
  const candidateTarballBytes = await readFile(candidateTarball).catch(() => undefined);
  const work = await mkdtemp(path.join(os.tmpdir(), "sc-offline-verify-"));
  try {
    const zipInfo = await lstat(file);
    if (!zipInfo.isFile() || zipInfo.isSymbolicLink()) throw new Error("Offline bundle must be a regular non-link file.");
    await extractZipSafe(file, work);
    const topLevel = (await readdir(work)).sort();
    if (topLevel.length !== 1 || topLevel[0] !== bundleName) {
      problems.push("Offline zip must contain exactly its versioned bundle directory.");
      return result(problems, packageJson.version);
    }
    const bundleRoot = path.join(work, bundleName);
    const packedPackage = await readJson(path.join(bundleRoot, "package", "package.json"), problems, "packed package.json");
    const bundlePackage = await readJson(path.join(bundleRoot, "package.json"), problems, "bundle package.json");
    const manifest = await readJson(path.join(bundleRoot, "bundle-manifest.json"), problems, "bundle manifest");
    for (const [label, value] of [["packed package", packedPackage], ["bundle package", bundlePackage]]) {
      if (value?.name !== packageJson.name || value?.version !== packageJson.version) {
        problems.push(`${label} name/version does not match the release candidate.`);
      }
    }
    const expectedLockHash = sha256(packageLockBytes);
    const expectedTarballHash = candidateTarballBytes === undefined ? undefined : sha256(candidateTarballBytes);
    if (manifest?.version !== 2
      || manifest?.package?.name !== packageJson.name
      || manifest?.package?.version !== packageJson.version
      || manifest?.package?.tarball !== `stinky-cobbler-${packageJson.version}.tgz`
      || expectedTarballHash === undefined
      || manifest?.package?.sha256 !== expectedTarballHash
      || manifest?.packageLockSha256 !== expectedLockHash
      || manifest?.dependencyVerification !== "canonical-lockfile-sri-offline-npm-ci-tree-v1") {
      problems.push("Offline bundle manifest does not bind the expected package and lockfile.");
    }
    const bundledLockBytes = await readFile(path.join(bundleRoot, "package-lock.json")).catch(() => undefined);
    if (bundledLockBytes === undefined || !bundledLockBytes.equals(packageLockBytes)) {
      problems.push("Offline bundle package-lock.json is not byte-for-byte equal to the release lockfile.");
    }
    const bundledPackageBytes = await readFile(path.join(bundleRoot, "package.json")).catch(() => undefined);
    if (bundledPackageBytes === undefined || !bundledPackageBytes.equals(packageJsonBytes)) {
      problems.push("Offline bundle package.json is not byte-for-byte equal to the release package.json.");
    }
    if (candidateTarballBytes !== undefined) {
      const candidateRoot = path.join(work, "candidate-tarball");
      await mkdir(candidateRoot);
      await extractNpmTarballSafe(candidateTarball, candidateRoot);
      try {
        const [candidateTree, bundledTree] = await Promise.all([
          directoryFingerprint(path.join(candidateRoot, "package"), { includeExecutable: false }),
          directoryFingerprint(path.join(bundleRoot, "package"), { includeExecutable: false })
        ]);
        if (JSON.stringify(candidateTree) !== JSON.stringify(bundledTree)) {
          problems.push("Offline bundle package tree does not exactly match the release-candidate tarball.");
        }
      } catch {
        problems.push("Offline bundle package tree contains a missing, linked, or non-regular entry.");
      }
    }

    const canonicalManual = await readFile(path.join(bundleRoot, "package", "docs", "quickstart", "使用说明书.md")).catch(() => undefined);
    const copiedManual = await readFile(path.join(bundleRoot, "使用说明书.md")).catch(() => undefined);
    if (canonicalManual === undefined || copiedManual === undefined || !canonicalManual.equals(copiedManual)) {
      problems.push("Offline bundle manual is missing or differs from the packaged canonical manual.");
    }
    for (const [relative, launcher] of Object.entries(OFFLINE_LAUNCHERS)) {
      try {
        const info = await lstat(path.join(bundleRoot, ...relative.split("/")));
        if (!info.isFile() || info.isSymbolicLink()) {
          problems.push(`Offline bundle launcher ${relative} must be a regular file.`);
          continue;
        }
        if (launcher.executable && process.platform !== "win32" && (info.mode & 0o111) === 0) {
          // The pure-JS extractor intentionally creates regular files only;
          // restore the mode recorded by the release contract before smoke use.
          await chmod(path.join(bundleRoot, ...relative.split("/")), 0o755);
        }
        if (!(await readFile(path.join(bundleRoot, ...relative.split("/")))).equals(Buffer.from(launcher.contents))) {
          problems.push(`Offline bundle launcher ${relative} does not match the release contract.`);
        }
      } catch {
        problems.push(`Offline bundle entry ${relative} is missing.`);
      }
    }
    try {
      const info = await lstat(path.join(bundleRoot, "node_modules"));
      if (!info.isDirectory() || info.isSymbolicLink()) problems.push("Offline bundle node_modules must be a real directory.");
    } catch {
      problems.push("Offline bundle entry node_modules is missing.");
    }
    const npmCache = path.join(bundleRoot, "npm-cache");
    try {
      const info = await lstat(npmCache);
      if (!info.isDirectory() || info.isSymbolicLink()) problems.push("Offline bundle npm-cache must be a real directory.");
    } catch {
      problems.push("Offline bundle entry npm-cache is missing.");
    }

    // Do not execute launchers or npm against bytes that already failed the
    // archive, candidate, manifest, manual, or launcher binding checks.
    if (problems.length > 0) return result(problems, packageJson.version);

    try {
      const launcher = process.platform === "win32"
        ? windowsCmdInvocation(path.join(bundleRoot, "bin", "stinky-cobbler.cmd"), ["--version"])
        : { command: path.join(bundleRoot, "bin", "stinky-cobbler"), args: ["--version"] };
      const version = execFileSync(launcher.command, launcher.args, {
        cwd: bundleRoot,
        encoding: "utf8",
        env: { ...process.env, npm_config_offline: "true" }
      }).trim();
      if (version !== packageJson.version) problems.push("Offline bundle CLI reports the wrong version.");
    } catch {
      problems.push("Offline bundle CLI launcher smoke test failed.");
    }
    try {
      const launcher = process.platform === "win32"
        ? windowsCmdInvocation(path.join(bundleRoot, "bin", "stinky-cobbler-mcp.cmd"))
        : { command: path.join(bundleRoot, "bin", "stinky-cobbler-mcp"), args: [] };
      execFileSync(launcher.command, launcher.args, {
        cwd: bundleRoot,
        input: "",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, npm_config_offline: "true" }
      });
    } catch {
      problems.push("Offline bundle MCP launcher smoke test failed.");
    }
    const rebuilt = path.join(work, "rebuilt-from-canonical-lock");
    try {
      await mkdir(rebuilt);
      await copyFile(path.join(sourceRoot, "package.json"), path.join(rebuilt, "package.json"));
      await copyFile(path.join(sourceRoot, "package-lock.json"), path.join(rebuilt, "package-lock.json"));
      execPortableSync(npmExecutable(), [
        "ci", "--omit=dev", "--ignore-scripts", "--offline", "--no-audit", "--no-fund",
        "--registry=https://registry.npmjs.org", "--cache", npmCache
      ], {
        stdio: "ignore",
        cwd: rebuilt,
        env: { ...process.env, npm_config_offline: "true" }
      });
      await mkdir(path.join(rebuilt, "node_modules"), { recursive: true });
      await Promise.all([
        removeNonRuntimeBin(path.join(rebuilt, "node_modules")),
        removeNonRuntimeBin(path.join(bundleRoot, "node_modules"))
      ]);
      const [rebuiltTree, bundledTree] = await Promise.all([
        directoryFingerprint(path.join(rebuilt, "node_modules"), { includeExecutable: false }),
        directoryFingerprint(path.join(bundleRoot, "node_modules"), { includeExecutable: false })
      ]);
      if (JSON.stringify(rebuiltTree) !== JSON.stringify(bundledTree)) {
        problems.push("Offline bundle dependency bytes do not match a fresh canonical-lockfile offline npm ci tree.");
      }
    } catch (error) {
      const reason = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "verification-error";
      problems.push(`Offline bundle dependencies cannot be rebuilt from canonical lockfile SRI using its independent npm cache (${reason}).`);
    }
    return result(problems, packageJson.version);
  } catch (error) {
    problems.push(`Offline bundle extraction failed: ${error instanceof Error ? error.message : String(error)}`);
    return result(problems, packageJson.version);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function result(problems, version) {
  return { valid: problems.length === 0, version, problems };
}

async function readJson(file, problems, label) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    problems.push(`${label} is missing or invalid.`);
    return undefined;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const index = process.argv.indexOf("--file");
  const file = index >= 0 && process.argv[index + 1] !== undefined
    ? path.resolve(process.cwd(), process.argv[index + 1])
    : path.join(root, `stinky-cobbler-${packageJson.version}-offline-full.zip`);
  const verification = await verifyOfflineBundle(file);
  console.log(JSON.stringify(verification, null, 2));
  if (!verification.valid) process.exitCode = 1;
}

if (isDirectInvocation(import.meta.url)) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
