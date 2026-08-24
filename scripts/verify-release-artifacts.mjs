import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  integritySha512Hex,
  lockfileDependencyClass,
  lockfilePackageName,
  SBOM_INVENTORY_SCOPE,
  SBOM_PROPERTY_NAMES
} from "./generate-sbom.mjs";
import { isDirectInvocation } from "./release-utils.mjs";

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
  const expected = new Map();
  for (const [name, entry] of Object.entries(lockfile.packages ?? {})) {
    if (name === "") continue;
    if (typeof entry?.version !== "string") continue;
    let purlName;
    try {
      purlName = lockfilePackageName(name, entry);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : "Lockfile package name is invalid.");
      continue;
    }
    const encodedName = purlName.startsWith("@") ? `%40${purlName.slice(1)}` : purlName;
    const sha512 = integritySha512Hex(entry.integrity);
    const dependencyClass = lockfileDependencyClass(entry);
    const fingerprint = componentFingerprint({
      type: "library",
      name: purlName,
      version: entry.version,
      purl: `pkg:npm/${encodedName}@${entry.version}`,
      properties: [{ name: SBOM_PROPERTY_NAMES.lockfileDependencyClass, value: dependencyClass }],
      ...(sha512 === undefined ? {} : { hashes: [{ alg: "SHA-512", content: sha512 }] })
    });
    expected.set(fingerprint, (expected.get(fingerprint) ?? 0) + 1);
  }

  const actual = new Map();
  if (!Array.isArray(sbom?.components)) return ["SBOM has no components array."];
  for (const [index, component] of sbom.components.entries()) {
    if (!isComponentShape(component)) {
      problems.push(`SBOM component ${index} has an invalid required shape.`);
      continue;
    }
    problems.push(...validateHashes(component.hashes, index));
    problems.push(...validateComponentDependencyClass(component, index));
    const fingerprint = componentFingerprint(component);
    actual.set(fingerprint, (actual.get(fingerprint) ?? 0) + 1);
  }

  for (const [fingerprint, count] of expected) {
    const missing = count - (actual.get(fingerprint) ?? 0);
    if (missing > 0) problems.push(`Missing ${missing} SBOM component(s) for ${fingerprintLabel(fingerprint)}.`);
  }
  for (const [fingerprint, count] of actual) {
    const extra = count - (expected.get(fingerprint) ?? 0);
    if (extra > 0) problems.push(`Unexpected or duplicate ${extra} SBOM component(s) for ${fingerprintLabel(fingerprint)}.`);
  }
  return problems;
}

/** Requires the BOM to identify itself as a full source lockfile inventory with exact class counts. */
export function validateSbomInventory(sbom, lockfile) {
  let productionComponentCount = 0;
  let developmentComponentCount = 0;
  for (const [location, entry] of Object.entries(lockfile?.packages ?? {})) {
    if (location === "" || typeof entry?.version !== "string") continue;
    if (lockfileDependencyClass(entry) === "development") developmentComponentCount += 1;
    else productionComponentCount += 1;
  }
  const expected = new Map([
    [SBOM_PROPERTY_NAMES.inventoryScope, SBOM_INVENTORY_SCOPE],
    [SBOM_PROPERTY_NAMES.inventorySource, "package-lock.json"],
    [SBOM_PROPERTY_NAMES.componentCount, String(productionComponentCount + developmentComponentCount)],
    [SBOM_PROPERTY_NAMES.productionComponentCount, String(productionComponentCount)],
    [SBOM_PROPERTY_NAMES.developmentComponentCount, String(developmentComponentCount)]
  ]);
  const properties = sbom?.metadata?.properties;
  if (!Array.isArray(properties)) return ["SBOM metadata has no inventory properties array."];

  const problems = [];
  for (const [name, value] of expected) {
    const matching = properties.filter((property) => property?.name === name);
    if (matching.length !== 1 || matching[0]?.value !== value) {
      problems.push(`SBOM metadata property ${name} must equal ${value} exactly once.`);
    }
  }
  return problems;
}

/** The SBOM root component must identify the package being released. */
export function validateSbomApplication(sbom, packageJson) {
  const component = sbom?.metadata?.component;
  if (typeof packageJson?.name !== "string" || typeof packageJson?.version !== "string") {
    return ["package.json does not contain a valid release name and version."];
  }
  if (typeof component !== "object" || component === null || Array.isArray(component)
    || component.type !== "application"
    || component.name !== packageJson.name
    || component.version !== packageJson.version) {
    return ["SBOM metadata.component does not match the release package name and version."];
  }
  return [];
}

/** The standalone release manual must be generated byte-for-byte from the tracked canonical guide. */
export function validateReleaseManual(releaseManual, canonicalManual) {
  return Buffer.isBuffer(releaseManual) && Buffer.isBuffer(canonicalManual) && releaseManual.equals(canonicalManual)
    ? []
    : ["STINKY-COBBLER-MANUAL.md does not match docs/quickstart/使用说明书.md."];
}

/** Requires one exact candidate tgz/zip and their two exact checksum files. */
export function validateReleaseArtifactNames(entries, version) {
  const expectedTarball = `stinky-cobbler-${version}.tgz`;
  const expectedOfflineBundle = `stinky-cobbler-${version}-offline-full.zip`;
  const expectedSbom = `stinky-cobbler-${version}.sbom.cyclonedx.json`;
  const expectedChecksums = [`${expectedOfflineBundle}.sha256`, `${expectedTarball}.sha256`].sort();
  const tarballs = entries.filter((entry) => /^stinky-cobbler-.*\.tgz$/.test(entry)).sort();
  const offlineBundles = entries.filter((entry) => /^stinky-cobbler-.*-offline-full\.zip$/.test(entry)).sort();
  const checksums = entries.filter((entry) => /^stinky-cobbler-.*\.sha256$/.test(entry)).sort();
  const sboms = entries.filter((entry) => entry === "sbom.cyclonedx.json" || /^stinky-cobbler-.*\.sbom\.cyclonedx\.json$/.test(entry)).sort();
  const problems = [];
  if (tarballs.length !== 1 || tarballs[0] !== expectedTarball) {
    problems.push(`Release directory must contain exactly ${expectedTarball} and no stale tarballs.`);
  }
  if (offlineBundles.length !== 1 || offlineBundles[0] !== expectedOfflineBundle) {
    problems.push(`Release directory must contain exactly ${expectedOfflineBundle} and no stale offline bundles.`);
  }
  if (JSON.stringify(checksums) !== JSON.stringify(expectedChecksums)) {
    problems.push("Release directory must contain exactly the current tgz and offline zip checksum files.");
  }
  if (sboms.length !== 1 || sboms[0] !== expectedSbom) {
    problems.push(`Release directory must contain exactly ${expectedSbom} and no stale or unversioned SBOM.`);
  }
  return { expectedTarball, expectedOfflineBundle, expectedSbom, tarballs, offlineBundles, checksums, sboms, problems };
}

const HASH_HEX_LENGTHS = new Map([
  ["MD5", 32], ["SHA-1", 40], ["SHA-256", 64], ["SHA-384", 96], ["SHA-512", 128],
  ["SHA3-256", 64], ["SHA3-384", 96], ["SHA3-512", 128],
  ["BLAKE2b-256", 64], ["BLAKE2b-384", 96], ["BLAKE2b-512", 128], ["BLAKE3", 64]
]);

function isComponentShape(component) {
  return typeof component === "object" && component !== null && !Array.isArray(component)
    && component.type === "library"
    && typeof component.name === "string" && component.name.length > 0
    && typeof component.version === "string" && component.version.length > 0
    && typeof component.purl === "string" && decodePurlName(component.purl) === component.name;
}

function validateHashes(hashes, componentIndex) {
  if (hashes === undefined) return [];
  if (!Array.isArray(hashes) || hashes.length === 0) return [`SBOM component ${componentIndex} has an invalid hashes array.`];
  const problems = [];
  for (const [hashIndex, hash] of hashes.entries()) {
    const expectedLength = typeof hash?.alg === "string" ? HASH_HEX_LENGTHS.get(hash.alg) : undefined;
    if (expectedLength === undefined || typeof hash?.content !== "string"
      || hash.content.length !== expectedLength || !/^[0-9a-f]+$/.test(hash.content)) {
      problems.push(`SBOM component ${componentIndex} hash ${hashIndex} is not a valid CycloneDX hexadecimal digest.`);
    }
  }
  return problems;
}

function validateComponentDependencyClass(component, componentIndex) {
  if (!Array.isArray(component?.properties)) {
    return [`SBOM component ${componentIndex} has no lockfile dependency class.`];
  }
  const matching = component.properties.filter((property) => property?.name === SBOM_PROPERTY_NAMES.lockfileDependencyClass);
  if (matching.length !== 1 || !["production", "development"].includes(matching[0]?.value)) {
    return [`SBOM component ${componentIndex} must have exactly one valid lockfile dependency class.`];
  }
  return [];
}

function componentFingerprint(component) {
  const hashes = Array.isArray(component.hashes)
    ? component.hashes.map((hash) => `${String(hash?.alg)}:${String(hash?.content)}`).sort()
    : [];
  const dependencyClass = Array.isArray(component.properties)
    ? component.properties.find((property) => property?.name === SBOM_PROPERTY_NAMES.lockfileDependencyClass)?.value
    : undefined;
  return JSON.stringify([component.type, component.name, component.version, component.purl, hashes, dependencyClass]);
}

function fingerprintLabel(fingerprint) {
  try {
    const [, name, version] = JSON.parse(fingerprint);
    return `${String(name)}@${String(version)}`;
  } catch {
    return "an invalid component";
  }
}

/**
 * Verifies the release artifacts produced by the release-candidate workflow:
 * the CycloneDX SBOM must cover every lockfile package one-to-one, and each
 * package/offline artifacts must be the exact current version, each checksum
 * must match, and the standalone manual must match its tracked source.
 */
export async function verifyReleaseArtifacts() {
  const problems = [];

  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const entries = await readdir(root);
  const artifactNames = validateReleaseArtifactNames(entries, packageJson.version);
  problems.push(...artifactNames.problems);
  const { expectedTarball, expectedOfflineBundle, expectedSbom, tarballs, offlineBundles } = artifactNames;
  const sbom = JSON.parse(await readRegularNonLink(path.join(root, expectedSbom), "SBOM", problems) ?? "null");
  if (sbom?.bomFormat !== "CycloneDX" || sbom?.specVersion !== "1.5") {
    problems.push("SBOM is not a CycloneDX 1.5 document.");
  }
  const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  problems.push(...validateSbomApplication(sbom, packageJson));
  problems.push(...validateSbomInventory(sbom, lockfile));
  problems.push(...compareSbomToLock(sbom, lockfile));

  for (const artifact of [expectedTarball, expectedOfflineBundle]) {
    const artifactBytes = await readRegularNonLink(path.join(root, artifact), artifact, problems);
    if (artifactBytes === undefined) continue;
    const digest = createHash("sha256").update(artifactBytes).digest("hex");
    const checksumFile = path.join(root, `${artifact}.sha256`);
    const checksumBytes = await readRegularNonLink(checksumFile, `${artifact}.sha256`, problems);
    if (checksumBytes === undefined) continue;
    const line = checksumBytes.toString("utf8").trim();
    if (line !== `${digest}  ${artifact}`) {
      problems.push(`Checksum mismatch for ${artifact}.`);
    }
  }

  const releaseManual = await readFile(path.join(root, "STINKY-COBBLER-MANUAL.md")).catch(() => undefined);
  const canonicalManual = await readFile(path.join(root, "docs", "quickstart", "使用说明书.md")).catch(() => undefined);
  problems.push(...validateReleaseManual(releaseManual, canonicalManual));

  return { valid: problems.length === 0, sbomComponents: sbom?.components?.length ?? 0, tarballs: tarballs.length, offlineBundles: offlineBundles.length, problems };
}

export async function readRegularNonLink(file, label, problems) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      problems.push(`${label} must be a readable regular non-link file.`);
      return undefined;
    }
    return await readFile(file);
  } catch {
    problems.push(`${label} is missing or unreadable.`);
    return undefined;
  }
}

async function main() {
  const result = await verifyReleaseArtifacts();
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

if (isDirectInvocation(import.meta.url)) {
  await main();
}
