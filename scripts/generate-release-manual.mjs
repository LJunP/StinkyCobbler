import { COPYFILE_EXCL } from "node:constants";
import { createHash } from "node:crypto";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectInvocation } from "./release-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Generates the release attachment from the tracked canonical manual. */
export async function generateReleaseManual(source, out) {
  await copyFile(source, out, COPYFILE_EXCL);
  const contents = await readFile(out);
  return { valid: true, out, bytes: contents.byteLength, sha256: createHash("sha256").update(contents).digest("hex") };
}

async function main() {
  const source = path.join(root, "docs", "quickstart", "使用说明书.md");
  const out = path.join(root, "STINKY-COBBLER-MANUAL.md");
  console.log(JSON.stringify(await generateReleaseManual(source, out), null, 2));
}

if (isDirectInvocation(import.meta.url)) await main();
