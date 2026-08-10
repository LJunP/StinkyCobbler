import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Decodes a purl's npm name (e.g. `%40scope/name` -> `@scope/name`). */
export function decodePurlName(purl) {
  const match = typeof purl === "string" ? purl.match(/^pkg:npm\/([^@]+|%40[^@]+)@/) : null;
  return match?.[1] === undefined ? undefined : match[1].replaceAll("%40", "@");
}

/**
 * One-to-one SBOM vs lockfile comparison: every non-root lockfile package
 * must have a component with the exact decoded name and version.
 */
export function compareSbomToLock(sbom, lockfile) {
  const problems = [];
  const components = new Map(sbom.components.map((component) => [`${component.name}@${component.version}`, component]));
  for (const [name, entry] of Object.entries(lockfile.packages ?? {})) {
    if (name === "") continue;
    const purlName = name.startsWith("node_modules/") ? name.slice("node_modules/".length) : name;
    if (typeof entry?.version !== "string") continue;
    const key = `${purlName}@${entry.version}`;
    const found = components.get(key);
    if (!found) {
      problems.push(`Missing SBOM component for ${key}.`);
      continue;
    }
    if (decodePurlName(found.purl) !== purlName || found.version !== entry.version) {
      problems.push(`SBOM component mismatch for ${key}.`);
    }
  }
  return problems;
}

/**
 * Verifies the release artifacts produced by the release-candidate workflow:
 * the CycloneDX SBOM must cover every lockfile package one-to-one, and each
 * tarball's sha256sum file must match a recomputed digest of the artifact.
 */
export async function verifyReleaseArtifacts() {
  const problems = [];

  const sbom = JSON.parse(await readFile(path.join(root, "sbom.cyclonedx.json"), "utf8"));
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.5") {
    problems.push("SBOM is not a CycloneDX 1.5 document.");
  }
  const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  if (!Array.isArray(sbom.components)) {
    problems.push("SBOM has no components array.");
  } else {
    problems.push(...compareSbomToLock(sbom, lockfile));
  }

  const entries = await readdir(root);
  const tarballs = entries.filter((entry) => /^stinky-cobbler-.*\.tgz$/.test(entry)).sort();
  if (tarballs.length === 0) {
    problems.push("No stinky-cobbler tarball found to verify.");
  }
  for (const tarball of tarballs) {
    const digest = createHash("sha256").update(await readFile(path.join(root, tarball))).digest("hex");
    const checksumFile = path.join(root, `${tarball}.sha256`);
    let line;
    try {
      line = (await readFile(checksumFile, "utf8")).trim();
    } catch {
      problems.push(`Missing checksum file for ${tarball}.`);
      continue;
    }
    if (line !== `sha256 ${digest}  ${tarball}`) {
      problems.push(`Checksum mismatch for ${tarball}.`);
    }
  }

  return { valid: problems.length === 0, sbomComponents: sbom.components?.length ?? 0, tarballs: tarballs.length, problems };
}

async function main() {
  const result = await verifyReleaseArtifacts();
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
