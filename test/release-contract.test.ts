import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateReleaseGate } from "../scripts/release-gate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("release contract", () => {
  it("keeps package, lockfile, and embedded runtime versions aligned", async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };
    const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")) as { version: string; packages?: { "": { version: string } } };
    const source = await readFile(path.join(root, "src/version.ts"), "utf8");
    const match = source.match(/STINKY_COBBLER_VERSION\s*=\s*["']([^"']+)["']/);
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    const result = evaluateReleaseGate({
      packageJsonVersion: packageJson.version,
      lockfileVersion: lockfile.version,
      lockfileRootVersion: lockfile.packages?.[""]?.version,
      sourceVersion: match?.[1]
    });
    expect(result.valid).toBe(true);
  });

  it("declares release documentation in the package allowlist", async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { files: string[] };
    expect(packageJson.files).toEqual(expect.arrayContaining(["README.md", "LICENSE", "SECURITY.md", "CHANGELOG.md"]));
  });
});

describe("release gate pure function", () => {
  const aligned = {
    packageJsonVersion: "0.3.0",
    lockfileVersion: "0.3.0",
    lockfileRootVersion: "0.3.0",
    sourceVersion: "0.3.0"
  };

  it("accepts a matching git tag", () => {
    expect(evaluateReleaseGate({ ...aligned, gitRef: "v0.3.0" })).toMatchObject({ valid: true });
  });

  it("rejects a git tag that does not match the package version", () => {
    expect(evaluateReleaseGate({ ...aligned, gitRef: "v9.9.9" })).toMatchObject({ valid: false, tagMismatch: true });
  });

  it("skips tag validation for non-v refs such as branches", () => {
    expect(evaluateReleaseGate({ ...aligned, gitRef: "main" })).toMatchObject({ valid: true, tagNotApplicable: true });
  });

  it("accepts a workflow_dispatch version equal to the package version", () => {
    expect(evaluateReleaseGate({ ...aligned, expectedVersion: "0.3.0" })).toMatchObject({ valid: true });
  });

  it("rejects a workflow_dispatch version that differs from the package version", () => {
    expect(evaluateReleaseGate({ ...aligned, expectedVersion: "0.3.1" })).toMatchObject({ valid: false, dispatchMismatch: true });
    expect(evaluateReleaseGate({ ...aligned, expectedVersion: "not-semver" })).toMatchObject({ valid: false, dispatchMismatch: true });
  });

  it("rejects non-semver package versions and file-to-file mismatches", () => {
    expect(evaluateReleaseGate({ ...aligned, packageJsonVersion: "beta" }).valid).toBe(false);
    expect(evaluateReleaseGate({ ...aligned, lockfileVersion: "0.3.1" })).toMatchObject({ valid: false, mismatches: ["lockfile"] });
    expect(evaluateReleaseGate({ ...aligned, sourceVersion: undefined })).toMatchObject({ valid: false, mismatches: ["source"] });
  });
});
