import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { offlineBundleReadme, publishExclusive } from "../scripts/build-offline-bundle.mjs";
import { verifyOfflineBundle } from "../scripts/verify-offline-bundle.mjs";
import { OFFLINE_LAUNCHERS } from "../scripts/offline-bundle-contract.mjs";
import { createZipFromDirectory, execPortableSync, npmExecutable, removeNonRuntimeBin, safeArchivePath, windowsCmdInvocation } from "../scripts/release-utils.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stinky-offline-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("offline bundle exclusive publication", () => {
  it("rejects Windows drive, colon, backslash, UNC, and traversal archive paths", () => {
    for (const unsafe of ["C:/escape.txt", "named:stream", "\\\\server\\share\\file", "//server/share/file", "../escape.txt"]) {
      expect(() => safeArchivePath(unsafe)).toThrow();
    }
    expect(safeArchivePath("bundle/package/file.txt")).toBe("bundle/package/file.txt");
  });

  it("quotes a Windows cmd launcher path containing spaces as one /S /C command", () => {
    const launch = windowsCmdInvocation("C:\\Program Files\\Stinky Cobbler\\bin\\stinky-cobbler.cmd", ["--version"]);
    expect(launch.args).toEqual([
      "/d", "/s", "/c", '""C:\\Program Files\\Stinky Cobbler\\bin\\stinky-cobbler.cmd" --version"'
    ]);
  });

  it("requires preview, explicit confirmation, and side-effect review before host installation", () => {
    const readme = offlineBundleReadme("9.9.9");
    const preview = readme.indexOf("install-host --mcp --dry-run");
    const confirmation = readme.indexOf("explicitly confirm");
    const install = readme.indexOf("install-host --mcp                          # ZCode");
    expect(preview).toBeGreaterThan(-1);
    expect(confirmation).toBeGreaterThan(preview);
    expect(install).toBeGreaterThan(confirmation);
    expect(readme).toContain("Side effects:");
    expect(readme).toContain("Managed-state sidecars");
    expect(readme).toContain("Existing user-edited files are preserved");
  });

  it("never overwrites an existing file or dangling symlink", async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, "source.zip");
    const existing = path.join(root, "existing.zip");
    const dangling = path.join(root, "dangling.zip");
    await writeFile(source, "candidate", "utf8");
    await writeFile(existing, "prior", "utf8");
    await symlink(path.join(root, "missing-target"), dangling);

    await expect(publishExclusive(source, existing)).rejects.toThrow("Refusing to overwrite");
    await expect(publishExclusive(source, dangling)).rejects.toThrow("Refusing to overwrite");
    expect(await readFile(existing, "utf8")).toBe("prior");
  });

  it("allows exactly one concurrent publisher to claim the final path", async () => {
    const root = await temporaryDirectory();
    const first = path.join(root, "first.zip");
    const second = path.join(root, "second.zip");
    const target = path.join(root, "release.zip");
    await writeFile(first, "first", "utf8");
    await writeFile(second, "second", "utf8");

    const outcomes = await Promise.allSettled([
      publishExclusive(first, target),
      publishExclusive(second, target)
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(["first", "second"]).toContain(await readFile(target, "utf8"));
  });
});

describe("offline bundle candidate binding", () => {
  it("binds the manifest, lockfile bytes, and packaged tree to the current candidate", { timeout: 15_000 }, async () => {
    const fixture = await createFixture();
    await fixture.rebuildZip();
    await expect(verifyOfflineBundle(fixture.zip, fixture.sourceRoot)).resolves.toMatchObject({ valid: true, problems: [] });

    const manifest = JSON.parse(await readFile(fixture.manifest, "utf8"));
    manifest.package.sha256 = "0".repeat(64);
    await writeFile(fixture.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(path.join(fixture.bundleRoot, "package-lock.json"), `${fixture.lockfileText}\n`, "utf8");
    await writeFile(path.join(fixture.bundleRoot, "package", "not-in-candidate.txt"), "extra", "utf8");
    await fixture.rebuildZip();
    const tampered = await verifyOfflineBundle(fixture.zip, fixture.sourceRoot);
    expect(tampered.valid).toBe(false);
    expect(tampered.problems).toEqual(expect.arrayContaining([
      "Offline bundle manifest does not bind the expected package and lockfile.",
      "Offline bundle package-lock.json is not byte-for-byte equal to the release lockfile.",
      "Offline bundle package tree does not exactly match the release-candidate tarball."
    ]));
  });

  it("rejects dependency bytes not produced by a fresh offline npm ci from canonical lock SRI", { timeout: 15_000 }, async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.bundleRoot, "node_modules", "payload.js"), "unexpected dependency bytes\n", "utf8");
    await fixture.rebuildZip();
    const verification = await verifyOfflineBundle(fixture.zip, fixture.sourceRoot);
    expect(verification.valid).toBe(false);
    expect(verification.problems).toContain("Offline bundle dependency bytes do not match a fresh canonical-lockfile offline npm ci tree.");
  });
});

async function createFixture() {
  const root = await temporaryDirectory();
  const sourceRoot = path.join(root, "source");
  const candidateRoot = path.join(root, "candidate");
  const stage = path.join(root, "stage");
  const version = "9.9.9";
  const bundleName = `stinky-cobbler-${version}-offline-full`;
  const bundleRoot = path.join(stage, bundleName);
  const candidatePackage = path.join(candidateRoot, "package");
  const packageJsonText = `${JSON.stringify({ name: "stinky-cobbler", version, engines: { node: ">=22.0.0" } }, null, 2)}\n`;
  const lockfileText = `${JSON.stringify({
    name: "stinky-cobbler",
    version,
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "stinky-cobbler", version } }
  }, null, 2)}\n`;
  await mkdir(path.join(candidatePackage, "dist"), { recursive: true });
  await mkdir(path.join(candidatePackage, "docs", "quickstart"), { recursive: true });
  await writeFile(path.join(candidatePackage, "package.json"), packageJsonText, "utf8");
  await writeFile(path.join(candidatePackage, "dist", "cli.js"), `console.log(${JSON.stringify(version)});\n`, "utf8");
  await chmod(path.join(candidatePackage, "dist", "cli.js"), 0o755);
  await writeFile(path.join(candidatePackage, "dist", "mcp-server.js"), "// exits cleanly on EOF\n", "utf8");
  await writeFile(path.join(candidatePackage, "docs", "quickstart", "使用说明书.md"), "# Manual\n", "utf8");
  await mkdir(sourceRoot);
  await writeFile(path.join(sourceRoot, "package.json"), packageJsonText, "utf8");
  await writeFile(path.join(sourceRoot, "package-lock.json"), lockfileText, "utf8");
  const tarball = path.join(sourceRoot, `stinky-cobbler-${version}.tgz`);
  const packed = JSON.parse(execPortableSync(npmExecutable(), ["pack", "--json", "--ignore-scripts"], {
    cwd: candidatePackage,
    encoding: "utf8"
  }) as string);
  await rename(path.join(candidatePackage, packed[0].filename), tarball);

  await cp(candidatePackage, path.join(bundleRoot, "package"), { recursive: true });
  const dependencyStage = path.join(root, "dependency-stage");
  const npmCache = path.join(bundleRoot, "npm-cache");
  await mkdir(dependencyStage);
  await mkdir(npmCache, { recursive: true });
  await writeFile(path.join(dependencyStage, "package.json"), packageJsonText, "utf8");
  await writeFile(path.join(dependencyStage, "package-lock.json"), lockfileText, "utf8");
  execPortableSync(npmExecutable(), ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", npmCache], {
    cwd: dependencyStage,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" }
  });
  await mkdir(path.join(dependencyStage, "node_modules"), { recursive: true });
  await removeNonRuntimeBin(path.join(dependencyStage, "node_modules"));
  await rename(path.join(dependencyStage, "node_modules"), path.join(bundleRoot, "node_modules"));
  await mkdir(path.join(bundleRoot, "bin"));
  for (const [relative, launcher] of Object.entries(OFFLINE_LAUNCHERS)) {
    const destination = path.join(bundleRoot, ...relative.split("/"));
    await writeFile(destination, launcher.contents, "utf8");
    if (launcher.executable) await chmod(destination, 0o755);
  }
  await writeFile(path.join(bundleRoot, "package.json"), packageJsonText, "utf8");
  await writeFile(path.join(bundleRoot, "package-lock.json"), lockfileText, "utf8");
  await writeFile(path.join(bundleRoot, "使用说明书.md"), "# Manual\n", "utf8");
  const tarballHash = sha256(await readFile(tarball));
  const manifest = path.join(bundleRoot, "bundle-manifest.json");
  await writeFile(manifest, `${JSON.stringify({
    version: 2,
    package: { name: "stinky-cobbler", version, tarball: path.basename(tarball), sha256: tarballHash },
    packageLockSha256: sha256(Buffer.from(lockfileText)),
    dependencyVerification: "canonical-lockfile-sri-offline-npm-ci-tree-v1",
    node: ">=22.0.0"
  }, null, 2)}\n`, "utf8");
  const zip = path.join(sourceRoot, `${bundleName}.zip`);
  return {
    sourceRoot,
    bundleRoot,
    manifest,
    zip,
    tarballHash,
    lockfileText,
    rebuildZip: async () => {
      await rm(zip, { force: true });
      await createZipFromDirectory(bundleRoot, zip, bundleName);
    }
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
