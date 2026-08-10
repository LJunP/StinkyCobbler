import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateReleaseGate } from "./release-gate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const versionSource = await readFile(path.join(root, "src/version.ts"), "utf8");
const sourceMatch = versionSource.match(/STINKY_COBBLER_VERSION\s*=\s*["']([^"']+)["']/);
const result = evaluateReleaseGate({
  packageJsonVersion: packageJson.version,
  lockfileVersion: lockfile.version,
  lockfileRootVersion: lockfile.packages?.[""]?.version,
  sourceVersion: sourceMatch?.[1]
});
if (!result.valid) {
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ valid: true, version: result.version, actual: result.actual }));
}
