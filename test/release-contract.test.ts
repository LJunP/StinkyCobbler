import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { evaluateReleaseGate, parseReleaseGateArgs } from "../scripts/release-gate.mjs";
import { evaluateReleaseProvenance } from "../scripts/release-provenance.mjs";

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
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      files: string[];
      publishConfig?: { registry?: string };
    };
    expect(packageJson.files).toEqual(expect.arrayContaining(["README.md", "LICENSE", "SECURITY.md", "CHANGELOG.md"]));
    expect(packageJson.publishConfig?.registry).toBe("https://registry.npmjs.org/");
  });

  it("ships the canonical Apache-2.0 license text", async () => {
    const license = (await readFile(path.join(root, "LICENSE"), "utf8")).replaceAll("\r\n", "\n");
    expect(createHash("sha256").update(license).digest("hex")).toBe("cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30");
  });

  it("verifies Node 22 and 24 on Ubuntu, macOS, and Windows without POSIX-only verify steps", async () => {
    const workflowText = await readFile(path.join(root, ".github", "workflows", "release-candidate.yml"), "utf8");
    const workflow = parse(workflowText) as {
      jobs: {
        verify: {
          "runs-on": string;
          strategy: { matrix: { os: string[]; node: Array<string | number> } };
          steps: Array<{ name?: string; run?: string; shell?: string; env?: Record<string, string> }>;
        };
        artifacts: {
          "runs-on": string;
          needs: string;
          steps: Array<{ name?: string; run?: string; uses?: string; env?: Record<string, string> }>;
        };
      };
    };
    const verify = workflow.jobs.verify;
    const verifyScripts = verify.steps.flatMap((step) => step.run ?? []);
    expect(verify["runs-on"]).toBe("${{ matrix.os }}");
    expect(verify.strategy.matrix.os).toEqual(["ubuntu-latest", "macos-latest", "windows-latest"]);
    expect(verify.strategy.matrix.node.map(String)).toEqual(["22", "24"]);
    expect(verify.steps.every((step) => step.shell === undefined)).toBe(true);
    expect(verifyScripts.every((script) => !script.includes("\n"))).toBe(true);
    expect(verifyScripts.join("\n")).not.toMatch(/\/dev\/null|(?:^|\s)(?:bash|sh)(?:\s|$)/m);
    expect(workflow.jobs.artifacts).toMatchObject({ "runs-on": "ubuntu-latest", needs: "verify" });

    const allSteps = [...workflow.jobs.verify.steps, ...workflow.jobs.artifacts.steps];
    const gateSteps = allSteps.filter((step) => step.name?.startsWith("Require "));
    expect(gateSteps).toHaveLength(4);
    expect(gateSteps.every((step) => step.run === "node scripts/release-gate.mjs")).toBe(true);
    expect(gateSteps.every((step) => step.env?.RELEASE_GATE_GIT_REF !== undefined || step.env?.RELEASE_GATE_EXPECTED_VERSION !== undefined)).toBe(true);
    const dispatchGates = gateSteps.filter((step) => step.env?.RELEASE_GATE_EXPECTED_VERSION !== undefined);
    expect(dispatchGates).toHaveLength(2);
    expect(dispatchGates.every((step) => step.env?.RELEASE_GATE_GIT_REF !== undefined)).toBe(true);
    expect(allSteps.flatMap((step) => step.run ?? []).join("\n")).not.toMatch(/\$\{\{\s*(?:github\.ref_name|inputs\.version)\s*\}\}/);

    const artifactSteps = workflow.jobs.artifacts.steps;
    const auditIndex = artifactSteps.findIndex((step) => step.run === "npm audit --audit-level=high");
    const uploadIndex = artifactSteps.findIndex((step) => step.uses?.includes("actions/upload-artifact"));
    expect(auditIndex).toBeGreaterThan(-1);
    expect(uploadIndex).toBeGreaterThan(auditIndex);
    const upload = artifactSteps[uploadIndex] as { with?: { name?: string; path?: string } };
    expect(upload.with?.name).toBe("stinky-cobbler-${{ steps.provenance.outputs.version }}-${{ steps.provenance.outputs.ref }}-${{ steps.provenance.outputs.sha }}");
    expect(upload.with?.path).toContain("stinky-cobbler-*.sbom.cyclonedx.json");
  });

  it("uses only validated main-or-exact-tag provenance in artifact names", () => {
    const aligned = {
      packageJsonVersion: "2.0.1",
      lockfileVersion: "2.0.1",
      lockfileRootVersion: "2.0.1",
      sourceVersion: "2.0.1",
      sha: "a".repeat(40)
    };
    expect(evaluateReleaseProvenance({ ...aligned, eventName: "workflow_dispatch", expectedVersion: "2.0.1", gitRef: "main" }))
      .toMatchObject({ valid: true, version: "2.0.1", ref: "main" });
    expect(evaluateReleaseProvenance({ ...aligned, eventName: "push", gitRef: "v2.0.1" }))
      .toMatchObject({ valid: true, version: "2.0.1", ref: "v2.0.1" });
    expect(evaluateReleaseProvenance({ ...aligned, eventName: "workflow_dispatch", expectedVersion: "2.0.1", gitRef: "feature/x" }))
      .toMatchObject({ valid: false, eventValid: false });
    expect(evaluateReleaseProvenance({ ...aligned, eventName: "push", gitRef: "main" }))
      .toMatchObject({ valid: false, eventValid: false });
    expect(evaluateReleaseProvenance({ ...aligned, sha: "unsafe", eventName: "push", gitRef: "v2.0.1" }))
      .toMatchObject({ valid: false, shaValid: false });
  });

  it("builds every promised release asset from the same local candidate", async () => {
    const workflow = await readFile(path.join(root, ".github", "workflows", "release-candidate.yml"), "utf8");
    const offlineBuilder = await readFile(path.join(root, "scripts", "build-offline-bundle.mjs"), "utf8");
    expect(workflow).toContain("node scripts/build-offline-bundle.mjs");
    expect(workflow).toContain("node scripts/verify-offline-bundle.mjs");
    expect(workflow).toContain("node scripts/generate-release-manual.mjs");
    expect(workflow).toContain(".sbom.cyclonedx.json");
    expect(workflow).toContain("generate-checksum.mjs --kind tarball --file");
    expect(workflow).toContain("generate-checksum.mjs --kind offline --file");
    expect(workflow).toContain("stinky-cobbler-*-offline-full.zip.sha256");
    expect(workflow).toContain("STINKY-COBBLER-MANUAL.md");
    expect(offlineBuilder).toContain("--tarball");
    expect(offlineBuilder).toContain("package-lock.json");
    expect(offlineBuilder).not.toMatch(/stinky-cobbler@\$\{version\}/);
  });

  it("keeps the integrity-pinned lockfile portable across explicit registries", async () => {
    const npmrc = await readFile(path.join(root, ".npmrc"), "utf8");
    const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")) as { packages: Record<string, { integrity?: string; resolved?: string }> };
    expect(npmrc).toContain("omit-lockfile-registry-resolved=true");
    expect(Object.values(lockfile.packages).every((entry) => entry.resolved === undefined)).toBe(true);
    expect(Object.entries(lockfile.packages).filter(([location]) => location !== "").every(([, entry]) => typeof entry.integrity === "string")).toBe(true);
    expect(lockfile.packages["node_modules/fflate"]).toMatchObject({
      version: "0.8.3",
      integrity: "sha512-tbZNuJrLwGUp3zshBtdy4W+ORxZuIh8a5ilyIEQDC5rY1f3U20JMry0Ll3WBzU58EZKsEuJFXhb5gwv8CsPvgA=="
    });
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

  it("accepts workflow_dispatch only from main or its exact version tag", () => {
    expect(evaluateReleaseGate({ ...aligned, expectedVersion: "0.3.0", gitRef: "main" })).toMatchObject({ valid: true });
    expect(evaluateReleaseGate({ ...aligned, expectedVersion: "0.3.0", gitRef: "v0.3.0" })).toMatchObject({ valid: true });
    expect(evaluateReleaseGate({ ...aligned, expectedVersion: "0.3.0", gitRef: "feature/release" }))
      .toMatchObject({ valid: false, dispatchRefMismatch: true });
  });

  it("rejects a workflow_dispatch version that differs from the package version", () => {
    expect(evaluateReleaseGate({ ...aligned, expectedVersion: "0.3.1", gitRef: "main" })).toMatchObject({ valid: false, dispatchMismatch: true });
    expect(evaluateReleaseGate({ ...aligned, expectedVersion: "not-semver", gitRef: "main" })).toMatchObject({ valid: false, dispatchMismatch: true });
  });

  it("rejects non-semver package versions and file-to-file mismatches", () => {
    expect(evaluateReleaseGate({ ...aligned, packageJsonVersion: "beta" }).valid).toBe(false);
    expect(evaluateReleaseGate({ ...aligned, lockfileVersion: "0.3.1" })).toMatchObject({ valid: false, mismatches: ["lockfile"] });
    expect(evaluateReleaseGate({ ...aligned, sourceVersion: undefined })).toMatchObject({ valid: false, mismatches: ["source"] });
  });
});

describe("release gate arguments", () => {
  it("accepts each supported argument exactly once", () => {
    expect(Object.fromEntries(parseReleaseGateArgs(["--expected", "2.0.1", "--git-ref", "v2.0.1"]))).toEqual({
      "--expected": "2.0.1",
      "--git-ref": "v2.0.1"
    });
  });

  it("fails closed on missing values, typos, and duplicates", () => {
    expect(() => parseReleaseGateArgs(["--expected"])).toThrow(/Missing value/);
    expect(() => parseReleaseGateArgs(["--expected", "--git-ref"])).toThrow(/Missing value/);
    expect(() => parseReleaseGateArgs(["--expeted", "2.0.1"])).toThrow(/Unknown/);
    expect(() => parseReleaseGateArgs(["--expected", "2.0.1", "--expected", "2.0.1"])).toThrow(/Duplicate/);
  });

  it("executes the real CLI entry and exits nonzero for a wrong declared version", () => {
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "release-gate.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, RELEASE_GATE_EXPECTED_VERSION: "9.9.9", RELEASE_GATE_GIT_REF: "main" }
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('"valid": false');
  });
});
