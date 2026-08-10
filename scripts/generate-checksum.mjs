import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Computes a sha256sum-compatible line: `sha256 <hex>  <basename>`. */
export async function checksumLine(file) {
  const digest = createHash("sha256").update(await readFile(file)).digest("hex");
  return `sha256 ${digest}  ${path.basename(file)}\n`;
}

/** Finds the newest stinky-cobbler tarball in the repository root. */
export async function findTarball() {
  const entries = await readdir(root);
  const tarballs = [];
  for (const entry of entries) {
    if (!/^stinky-cobbler-.*\.tgz$/.test(entry)) continue;
    const info = await stat(path.join(root, entry));
    tarballs.push({ entry, mtime: info.mtimeMs });
  }
  tarballs.sort((left, right) => right.mtime - left.mtime);
  return tarballs[0]?.entry;
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === undefined) continue;
    const value = process.argv[index + 1];
    if (argument.startsWith("--") && value !== undefined && !value.startsWith("--")) {
      args.set(argument, value);
      index += 1;
    }
  }
  let file = args.get("--file");
  if (file === undefined) {
    const tarball = await findTarball();
    if (tarball === undefined) {
      console.error(JSON.stringify({ valid: false, error: "No stinky-cobbler tarball found; pass --file." }));
      process.exitCode = 1;
      return;
    }
    file = path.join(root, tarball);
  }
  const line = await checksumLine(file);
  const out = `${file}.sha256`;
  await writeFile(out, line, "utf8");
  console.log(JSON.stringify({ valid: true, file, out, checksum: line.trim() }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
