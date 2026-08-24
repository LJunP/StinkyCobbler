import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectInvocation } from "./release-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Computes a sha256sum-compatible line: `<hex>  <basename>`. */
export async function checksumLine(file) {
  const digest = createHash("sha256").update(await readFile(file)).digest("hex");
  return `${digest}  ${path.basename(file)}\n`;
}

export async function writeChecksumExclusive(file) {
  const line = await checksumLine(file);
  const out = `${file}.sha256`;
  await writeFile(out, line, { encoding: "utf8", flag: "wx" });
  return { line, out };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kind = args.get("--kind") ?? "tarball";
  if (kind !== "tarball" && kind !== "offline") {
    console.error(JSON.stringify({ valid: false, error: "--kind must be tarball or offline." }));
    process.exitCode = 1;
    return;
  }
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const expectedName = kind === "offline"
    ? `stinky-cobbler-${packageJson.version}-offline-full.zip`
    : `stinky-cobbler-${packageJson.version}.tgz`;
  const file = path.resolve(root, args.get("--file") ?? expectedName);
  if (file !== path.join(root, expectedName)) {
    throw new Error(`Checksum input must be the exact repository-root current artifact ${expectedName}.`);
  }
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Checksum input must be a regular non-link file: ${expectedName}`);
  const { line, out } = await writeChecksumExclusive(file);
  console.log(JSON.stringify({ valid: true, file, out, checksum: line.trim() }, null, 2));
}

function parseArgs(argv) {
  const allowed = new Set(["--file", "--kind"]);
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || typeof value !== "string" || value === "" || value.startsWith("--") || args.has(key)) {
      throw new Error("Usage: node scripts/generate-checksum.mjs [--kind tarball|offline] [--file <exact-current-artifact>]");
    }
    args.set(key, value);
  }
  return args;
}

if (isDirectInvocation(import.meta.url)) {
  await main();
}
