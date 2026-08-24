import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSbom, integritySha512Hex, lockfilePackageName, SBOM_INVENTORY_SCOPE, SBOM_PROPERTY_NAMES, writeSbomExclusive } from "../scripts/generate-sbom.mjs";
import { compareSbomToLock, decodePurlName, readRegularNonLink, validateReleaseArtifactNames, validateReleaseManual, validateSbomApplication, validateSbomInventory } from "../scripts/verify-release-artifacts.mjs";
import { checksumLine, writeChecksumExclusive } from "../scripts/generate-checksum.mjs";
import { generateReleaseManual } from "../scripts/generate-release-manual.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDirs: string[] = [];
afterEach(async () => { await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stinky-sbom-"));
  tmpDirs.push(dir);
  return dir;
}

describe("dependency SBOM generation", () => {
  it("builds a CycloneDX 1.5 document covering every lockfile package with integrity hashes", async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { name: string; version: string };
    const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string; integrity?: string }> };
    const sbom = buildSbom(packageJson, lockfile, { serialNumber: "test-serial" });

    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.specVersion).toBe("1.5");
    expect(sbom.serialNumber).toBe("urn:uuid:test-serial");
    expect(sbom.metadata.component).toMatchObject({ type: "application", name: packageJson.name, version: packageJson.version });

    const inventoryProperties = Object.fromEntries(sbom.metadata.properties.map(({ name, value }) => [name, value]));
    const entries = Object.entries(lockfile.packages).filter(([name, entry]) => name !== "" && typeof entry.version === "string");
    const expected = entries.length;
    const expectedDevelopment = entries.filter(([, entry]) => entry.dev === true).length;
    expect(inventoryProperties).toMatchObject({
      [SBOM_PROPERTY_NAMES.inventoryScope]: SBOM_INVENTORY_SCOPE,
      [SBOM_PROPERTY_NAMES.inventorySource]: "package-lock.json",
      [SBOM_PROPERTY_NAMES.componentCount]: String(expected),
      [SBOM_PROPERTY_NAMES.productionComponentCount]: String(expected - expectedDevelopment),
      [SBOM_PROPERTY_NAMES.developmentComponentCount]: String(expectedDevelopment)
    });
    expect(sbom.components.length).toBe(expected);
    for (const component of sbom.components) {
      expect(component.type).toBe("library");
      expect(component.name).toBeTruthy();
      expect(component.version).toBeTruthy();
      expect(component.purl).toMatch(/^pkg:npm\/.+@.+/);
      expect(component.properties).toEqual([
        expect.objectContaining({ name: SBOM_PROPERTY_NAMES.lockfileDependencyClass, value: expect.stringMatching(/^(?:production|development)$/) })
      ]);
      if (typeof component.hashes === "object" && component.hashes !== null) {
        expect(component.hashes).toEqual([expect.objectContaining({ alg: "SHA-512", content: expect.stringMatching(/^[0-9a-f]{128}$/) })]);
      }
    }
  });

  it("converts npm SRI SHA-512 base64 to the hexadecimal representation required by CycloneDX", () => {
    const bytes = Buffer.alloc(64, 0xab);
    expect(integritySha512Hex(`sha512-${bytes.toString("base64")}`)).toBe(bytes.toString("hex"));
    expect(integritySha512Hex("sha512-abc")).toBeUndefined();
  });

  it("omits hashes when integrity is absent and skips packages without versions", () => {
    const packageJson = { name: "test-package", version: "0.0.0" };
    const lockfile = {
      packages: {
        "": { version: "0.0.0" },
        "node_modules/plain": { version: "1.0.0" },
        "node_modules/no-integrity": { version: "2.0.0" },
        "node_modules/no-version": { integrity: "sha512-abc" }
      }
    };
    const sbom = buildSbom(packageJson, lockfile as never);
    expect(sbom.components).toHaveLength(2);
    expect(sbom.components.find((item) => item.name === "plain")?.hashes).toBeUndefined();
    expect(sbom.components.find((item) => item.name === "no-version")).toBeUndefined();
  });

  it("URL-encodes scoped package names in purls", () => {
    const sbom = buildSbom({ name: "test", version: "1.0.0" }, { packages: { "node_modules/@scope/name": { version: "1.2.3" } } });
    expect(sbom.components[0].purl).toBe("pkg:npm/%40scope/name@1.2.3");
    expect(decodePurlName(sbom.components[0].purl)).toBe("@scope/name");
  });

  it("uses the real nested npm package name and preserves duplicate installation multiplicity", () => {
    const lockfile = {
      packages: {
        "": { version: "1.0.0" },
        "node_modules/parent/node_modules/child": { version: "2.0.0", dev: true },
        "node_modules/other/node_modules/child": { version: "2.0.0" },
        "node_modules/parent/node_modules/@scope/nested": { version: "3.0.0" }
      }
    };
    const sbom = buildSbom({ name: "test", version: "1.0.0" }, lockfile);
    expect(sbom.components.filter((item) => item.name === "child")).toHaveLength(2);
    expect(sbom.components.find((item) => item.name === "child" && item.properties[0]?.value === "development")).toBeDefined();
    expect(sbom.components.find((item) => item.name === "child" && item.properties[0]?.value === "production")).toBeDefined();
    expect(sbom.components.filter((item) => item.purl === "pkg:npm/child@2.0.0")).toHaveLength(2);
    expect(sbom.components).toContainEqual(expect.objectContaining({ name: "@scope/nested", purl: "pkg:npm/%40scope/nested@3.0.0" }));
    expect(sbom.components.every((item) => !item.name.includes("/node_modules/") && !item.purl.includes("/node_modules/"))).toBe(true);
    expect(compareSbomToLock(sbom, lockfile)).toEqual([]);
    expect(lockfilePackageName("node_modules/a/node_modules/@scope/nested")).toBe("@scope/nested");
  });
});

describe("release artifact one-to-one comparison", () => {
  const lockfile = {
    packages: {
      "": { version: "1.0.0" },
      "node_modules/alpha": { version: "1.0.0" },
      "node_modules/@scope/beta": { version: "2.0.0" }
    }
  };

  it("accepts a fully matching SBOM", () => {
    const sbom = buildSbom({ name: "test", version: "1.0.0" }, lockfile as never);
    expect(validateSbomInventory(sbom, lockfile)).toEqual([]);
    expect(compareSbomToLock(sbom, lockfile)).toEqual([]);
  });

  it("rejects false inventory scope, count, and dependency-class claims", () => {
    const classifiedLockfile = structuredClone(lockfile);
    classifiedLockfile.packages["node_modules/@scope/beta"].dev = true;
    const matching = buildSbom({ name: "test", version: "1.0.0" }, classifiedLockfile as never);

    const wrongScope = structuredClone(matching);
    wrongScope.metadata.properties.find((property) => property.name === SBOM_PROPERTY_NAMES.inventoryScope)!.value = "runtime";
    expect(validateSbomInventory(wrongScope, classifiedLockfile).some((problem) => problem.includes(SBOM_PROPERTY_NAMES.inventoryScope))).toBe(true);

    const wrongCount = structuredClone(matching);
    wrongCount.metadata.properties.find((property) => property.name === SBOM_PROPERTY_NAMES.developmentComponentCount)!.value = "0";
    expect(validateSbomInventory(wrongCount, classifiedLockfile).some((problem) => problem.includes(SBOM_PROPERTY_NAMES.developmentComponentCount))).toBe(true);

    const wrongClass = structuredClone(matching);
    const beta = wrongClass.components.find((component) => component.name === "@scope/beta")!;
    beta.properties[0]!.value = "production";
    expect(compareSbomToLock(wrongClass, classifiedLockfile).some((problem) => problem.includes("@scope/beta@2.0.0"))).toBe(true);
  });

  it("reports missing and version-mismatched components", () => {
    const sbom = { components: [{ name: "alpha", version: "9.9.9", purl: "pkg:npm/alpha@9.9.9" }] };
    const problems = compareSbomToLock(sbom, lockfile);
    expect(problems.some((problem) => problem.includes("alpha@1.0.0"))).toBe(true);
    expect(problems.some((problem) => problem.includes("@scope/beta@2.0.0"))).toBe(true);
  });

  it("rejects duplicate, extra, and non-hexadecimal hash components", () => {
    const matching = buildSbom({ name: "test", version: "1.0.0" }, lockfile as never);
    const duplicate = structuredClone(matching.components[0]);
    const extra = { type: "library", name: "extra", version: "1.0.0", purl: "pkg:npm/extra@1.0.0" };
    const malformed = structuredClone(matching.components[1]);
    malformed.hashes = [{ alg: "SHA-512", content: Buffer.alloc(64).toString("base64") }];
    const problems = compareSbomToLock({ components: [...matching.components, duplicate, extra, malformed] }, lockfile);
    expect(problems.some((problem) => problem.includes("duplicate"))).toBe(true);
    expect(problems.some((problem) => problem.includes("extra@1.0.0"))).toBe(true);
    expect(problems.some((problem) => problem.includes("not a valid CycloneDX hexadecimal digest"))).toBe(true);
  });

  it("rejects an SBOM whose root application name or version was tampered", () => {
    const packageJson = { name: "stinky-cobbler", version: "2.0.1" };
    const matching = buildSbom(packageJson, lockfile as never);
    expect(validateSbomApplication(matching, packageJson)).toEqual([]);

    const wrongName = structuredClone(matching);
    wrongName.metadata.component.name = "another-application";
    expect(validateSbomApplication(wrongName, packageJson)).not.toEqual([]);

    const wrongVersion = structuredClone(matching);
    wrongVersion.metadata.component.version = "9.9.9";
    expect(validateSbomApplication(wrongVersion, packageJson)).not.toEqual([]);
  });
});

describe("tarball checksum generation", () => {
  it("rejects stale or extra release checksum files", () => {
    const current = [
      "stinky-cobbler-2.0.1.tgz",
      "stinky-cobbler-2.0.1-offline-full.zip",
      "stinky-cobbler-2.0.1.tgz.sha256",
      "stinky-cobbler-2.0.1-offline-full.zip.sha256",
      "stinky-cobbler-2.0.1.sbom.cyclonedx.json"
    ];
    expect(validateReleaseArtifactNames(current, "2.0.1").problems).toEqual([]);
    expect(validateReleaseArtifactNames([...current, "stinky-cobbler-2.0.0.tgz.sha256"], "2.0.1").problems)
      .toContain("Release directory must contain exactly the current tgz and offline zip checksum files.");
    expect(validateReleaseArtifactNames([...current, "sbom.cyclonedx.json"], "2.0.1").problems)
      .toContain("Release directory must contain exactly stinky-cobbler-2.0.1.sbom.cyclonedx.json and no stale or unversioned SBOM.");
  });

  it("writes a sha256sum-compatible line that matches a recomputed digest", async () => {
    const dir = await tmp();
    const file = path.join(dir, "sample.bin");
    const contents = Buffer.from("checksum sample content\n");
    await writeFile(file, contents);
    const line = await checksumLine(file);
    const digest = createHash("sha256").update(contents).digest("hex");
    expect(line).toBe(`${digest}  sample.bin\n`);
    await expect(writeChecksumExclusive(file)).resolves.toMatchObject({ out: `${file}.sha256` });
    await expect(writeChecksumExclusive(file)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("writes versioned SBOM bytes exclusively and never replaces an existing artifact", async () => {
    const dir = await tmp();
    const out = path.join(dir, "stinky-cobbler-2.0.1.sbom.cyclonedx.json");
    const sbom = buildSbom({ name: "stinky-cobbler", version: "2.0.1" }, { packages: {} }, { serialNumber: "exclusive-test" });
    await expect(writeSbomExclusive(out, sbom)).resolves.toBeUndefined();
    const first = await readFile(out);
    await expect(writeSbomExclusive(out, { tampered: true })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(out)).toEqual(first);
  });

  it("generates the standalone manual from its canonical bytes and never overwrites a prior file", async () => {
    const dir = await tmp();
    const source = path.join(dir, "source.md");
    const out = path.join(dir, "STINKY-COBBLER-MANUAL.md");
    const contents = Buffer.from("# Canonical manual\n");
    await writeFile(source, contents);
    await expect(generateReleaseManual(source, out)).resolves.toMatchObject({ valid: true, bytes: contents.byteLength });
    expect(await readFile(out)).toEqual(contents);
    expect(validateReleaseManual(await readFile(out), contents)).toEqual([]);
    expect(validateReleaseManual(Buffer.from("stale"), contents)).not.toEqual([]);
    await expect(generateReleaseManual(source, out)).rejects.toMatchObject({ code: "EEXIST" });
  });
});

describe("release artifact file type gate", () => {
  it("rejects missing files, directories, and symbolic links", async () => {
    const dir = await tmp();
    const problems: string[] = [];
    await expect(readRegularNonLink(path.join(dir, "missing.tgz"), "missing", problems)).resolves.toBeUndefined();
    await mkdir(path.join(dir, "directory.tgz"));
    await expect(readRegularNonLink(path.join(dir, "directory.tgz"), "directory", problems)).resolves.toBeUndefined();
    const target = path.join(dir, "target.tgz");
    await writeFile(target, "bytes", "utf8");
    const link = path.join(dir, "link.tgz");
    await symlink(target, link, "file");
    await expect(readRegularNonLink(link, "link", problems)).resolves.toBeUndefined();
    expect(problems).toEqual(expect.arrayContaining([
      "missing is missing or unreadable.",
      "directory must be a readable regular non-link file.",
      "link must be a readable regular non-link file."
    ]));
  });

  it.runIf(process.platform !== "win32")("rejects an unreadable regular file", async () => {
    const dir = await tmp();
    const file = path.join(dir, "unreadable.tgz");
    await writeFile(file, "bytes", "utf8");
    await chmod(file, 0o000);
    const problems: string[] = [];
    expect(await readRegularNonLink(file, "unreadable", problems)).toBeUndefined();
    expect(problems).toContain("unreadable is missing or unreadable.");
  });
});
