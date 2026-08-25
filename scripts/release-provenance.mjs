import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateReleaseGate, isAllowedDispatchRef } from "./release-gate.mjs";
import { isDirectInvocation } from "./release-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function evaluateReleaseProvenance(input) {
  const result = evaluateReleaseGate(input);
  const eventValid = input.eventName === "push"
    ? input.gitRef === `v${result.version}`
    : input.eventName === "workflow_dispatch" && isAllowedDispatchRef(input.gitRef, result.version);
  const shaValid = typeof input.sha === "string" && /^[0-9a-f]{40}$/.test(input.sha);
  const artifactRef = typeof input.gitRef === "string" ? input.gitRef.replaceAll("/", "-") : input.gitRef;
  return {
    valid: result.valid && eventValid && shaValid,
    version: result.version,
    ref: artifactRef,
    sourceRef: input.gitRef,
    sha: input.sha,
    releaseGate: result,
    eventValid,
    shaValid
  };
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const versionSource = await readFile(path.join(root, "src", "version.ts"), "utf8");
  const sourceMatch = versionSource.match(/STINKY_COBBLER_VERSION\s*=\s*["']([^"']+)["']/);
  const eventName = process.env.RELEASE_PROVENANCE_EVENT;
  const expectedVersion = eventName === "workflow_dispatch" ? process.env.RELEASE_GATE_EXPECTED_VERSION : undefined;
  const result = evaluateReleaseProvenance({
    packageJsonVersion: packageJson.version,
    lockfileVersion: lockfile.version,
    lockfileRootVersion: lockfile.packages?.[""]?.version,
    sourceVersion: sourceMatch?.[1],
    gitRef: process.env.RELEASE_GATE_GIT_REF,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    eventName,
    sha: process.env.RELEASE_PROVENANCE_SHA
  });
  if (!result.valid) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  }
  const output = process.env.GITHUB_OUTPUT;
  if (typeof output !== "string" || output === "") throw new Error("GITHUB_OUTPUT is required for validated release provenance.");
  await appendFile(output, `version=${result.version}\nref=${result.ref}\nsha=${result.sha}\n`, "utf8");
  console.log(JSON.stringify({ valid: true, version: result.version, ref: result.ref, sourceRef: result.sourceRef, sha: result.sha }));
}

if (isDirectInvocation(import.meta.url)) await main();
