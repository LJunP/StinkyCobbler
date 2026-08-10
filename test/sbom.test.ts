import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSbom } from "../scripts/generate-sbom.mjs";
import { compareSbomToLock, decodePurlName } from "../scripts/verify-release-artifacts.mjs";
import { checksumLine } from "../scripts/generate-checksum.mjs";

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

    const expected = Object.entries(lockfile.packages).filter(([name]) => name !== "").length;
    expect(sbom.components.length).toBe(expected);
    for (const component of sbom.components) {
      expect(component.type).toBe("library");
      expect(component.name).toBeTruthy();
      expect(component.version).toBeTruthy();
      expect(component.purl).toMatch(/^pkg:npm\/.+@.+/);
      if (typeof component.hashes === "object" && component.hashes !== null) {
        expect(component.hashes).toEqual([expect.objectContaining({ alg: "SHA-512" })]);
      }
    }
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
    expect(sbom.components.find((item) => item.name === "node_modules/plain")?.hashes).toBeUndefined();
    expect(sbom.components.find((item) => item.name === "node_modules/no-version")).toBeUndefined();
  });

  it("URL-encodes scoped package names in purls", () => {
    const sbom = buildSbom({ name: "test", version: "1.0.0" }, { packages: { "node_modules/@scope/name": { version: "1.2.3" } } });
    expect(sbom.components[0].purl).toBe("pkg:npm/%40scope/name@1.2.3");
    expect(decodePurlName(sbom.components[0].purl)).toBe("@scope/name");
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
    expect(compareSbomToLock(sbom, lockfile)).toEqual([]);
  });

  it("reports missing and version-mismatched components", () => {
    const sbom = { components: [{ name: "alpha", version: "9.9.9", purl: "pkg:npm/alpha@9.9.9" }] };
    const problems = compareSbomToLock(sbom, lockfile);
    expect(problems.some((problem) => problem.includes("alpha@1.0.0"))).toBe(true);
    expect(problems.some((problem) => problem.includes("@scope/beta@2.0.0"))).toBe(true);
  });
});

describe("tarball checksum generation", () => {
  it("writes a sha256sum-compatible line that matches a recomputed digest", async () => {
    const dir = await tmp();
    const file = path.join(dir, "sample.bin");
    const contents = Buffer.from("checksum sample content\n");
    await writeFile(file, contents);
    const line = await checksumLine(file);
    const digest = createHash("sha256").update(contents).digest("hex");
    expect(line).toBe(`sha256 ${digest}  sample.bin\n`);
  });
});
