import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectInvocation } from "./release-utils.mjs";

const STRICT_SEMVER = /^\d+\.\d+\.\d+$/;
const RELEASE_GATE_OPTIONS = new Set(["--git-ref", "--expected"]);

/**
 * Pure release gate: the package.json version is the single source of truth.
 * Validates file-to-file consistency, an optional git tag (`v*` must equal
 * `v${version}`), and an optional workflow_dispatch declared version.
 *
 * @param {object} input
 * @param {unknown} input.packageJsonVersion
 * @param {unknown} input.lockfileVersion
 * @param {unknown} input.lockfileRootVersion
 * @param {unknown} input.sourceVersion
 * @param {string} [input.gitRef] Git ref such as a tag (`v0.3.0`) or a branch (`main`).
 * @param {string} [input.expectedVersion] Explicit version declared by a workflow_dispatch run.
 * @returns {{valid: boolean, version?: string, actual: object, mismatches: string[], tagMismatch?: boolean, tagNotApplicable?: boolean, dispatchMismatch?: boolean}}
 */
export function evaluateReleaseGate(input) {
  const actual = {
    packageJson: input.packageJsonVersion,
    lockfile: input.lockfileVersion,
    lockfileRoot: input.lockfileRootVersion,
    source: input.sourceVersion
  };
  const mismatches = [];
  const expected = input.packageJsonVersion;
  const invalidVersion = typeof expected !== "string" || !STRICT_SEMVER.test(expected);
  for (const [name, value] of Object.entries(actual)) {
    if (value !== expected) mismatches.push(name);
  }

  const result = { valid: false, actual, mismatches };
  if (invalidVersion || mismatches.length > 0) return result;

  result.version = expected;
  result.valid = true;

  if (input.gitRef !== undefined) {
    if (input.gitRef.startsWith("v")) {
      if (input.gitRef !== `v${expected}`) {
        result.tagMismatch = true;
        result.valid = false;
      }
    } else {
      result.tagNotApplicable = true;
    }
  }
  if (input.expectedVersion !== undefined) {
    if (input.expectedVersion !== expected || !STRICT_SEMVER.test(input.expectedVersion)) {
      result.dispatchMismatch = true;
      result.valid = false;
    }
    if (input.gitRef !== "main" && input.gitRef !== `v${expected}`) {
      result.dispatchRefMismatch = true;
      result.valid = false;
    }
  }
  return result;
}

/** Strictly parses the two release-gate options; typos and missing values fail closed. */
export function parseReleaseGateArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!RELEASE_GATE_OPTIONS.has(argument)) {
      throw new Error(`Unknown release-gate argument: ${String(argument)}`);
    }
    if (args.has(argument)) throw new Error(`Duplicate release-gate argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for release-gate argument: ${argument}`);
    }
    args.set(argument, value);
    index += 1;
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseReleaseGateArgs(process.argv.slice(2));
  } catch (error) {
    console.log(JSON.stringify({ valid: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
    return;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const versionSource = await readFile(path.join(root, "src/version.ts"), "utf8");
  const sourceMatch = versionSource.match(/STINKY_COBBLER_VERSION\s*=\s*["']([^"']+)["']/);
  const gitRef = args.get("--git-ref") ?? process.env.RELEASE_GATE_GIT_REF;
  const expectedVersion = args.get("--expected") ?? process.env.RELEASE_GATE_EXPECTED_VERSION;
  const result = evaluateReleaseGate({
    packageJsonVersion: packageJson.version,
    lockfileVersion: lockfile.version,
    lockfileRootVersion: lockfile.packages?.[""]?.version,
    sourceVersion: sourceMatch?.[1],
    ...(gitRef === undefined ? {} : { gitRef }),
    ...(expectedVersion === undefined ? {} : { expectedVersion })
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

if (isDirectInvocation(import.meta.url)) {
  await main();
}
