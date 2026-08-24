import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectInvocation } from "./release-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SBOM_INVENTORY_SCOPE = "source-lockfile-full";
export const SBOM_PROPERTY_NAMES = Object.freeze({
  inventoryScope: "stinky-cobbler:sbom:inventory-scope",
  inventorySource: "stinky-cobbler:sbom:inventory-source",
  componentCount: "stinky-cobbler:sbom:component-count",
  productionComponentCount: "stinky-cobbler:sbom:lockfile-production-component-count",
  developmentComponentCount: "stinky-cobbler:sbom:lockfile-development-component-count",
  lockfileDependencyClass: "stinky-cobbler:sbom:lockfile-dependency-class"
});

/** Classifies package-lock entries without claiming that production entries necessarily execute at runtime. */
export function lockfileDependencyClass(entry) {
  return entry?.dev === true ? "development" : "production";
}

/** Converts an npm SRI SHA-512 digest to CycloneDX's lowercase hexadecimal form. */
export function integritySha512Hex(integrity) {
  if (typeof integrity !== "string") return undefined;
  const match = integrity.match(/^sha512-([A-Za-z0-9+/=]+)$/);
  if (match?.[1] === undefined) return undefined;
  const digest = Buffer.from(match[1], "base64");
  return digest.byteLength === 64 ? digest.toString("hex") : undefined;
}

/** Resolves a package-lock `packages` location to the actual npm package name. */
export function lockfilePackageName(location, entry = {}) {
  if (typeof entry?.name === "string" && entry.name.length > 0) return assertPackageName(entry.name, location);
  if (typeof location !== "string" || location.length === 0) throw new Error("A non-root lockfile package location is required.");
  const normalized = location.replaceAll("\\", "/");
  const nestedMarker = "/node_modules/";
  const nestedIndex = normalized.lastIndexOf(nestedMarker);
  const candidate = nestedIndex >= 0
    ? normalized.slice(nestedIndex + nestedMarker.length)
    : normalized.startsWith("node_modules/") ? normalized.slice("node_modules/".length) : "";
  return assertPackageName(candidate, location);
}

function assertPackageName(candidate, location) {
  if (!/^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/.test(candidate)) {
    throw new Error(`Cannot derive a valid npm package name from lockfile location ${location}.`);
  }
  return candidate;
}

/** Builds a CycloneDX 1.5 BOM from package-lock.json packages. */
export function buildSbom(packageJson, lockfile, options = {}) {
  const components = [];
  let productionComponentCount = 0;
  let developmentComponentCount = 0;
  for (const [name, entry] of Object.entries(lockfile.packages ?? {})) {
    if (name === "") continue;
    if (typeof entry?.version !== "string") continue;
    const purlName = lockfilePackageName(name, entry);
    const encodedName = purlName.startsWith("@") ? `%40${purlName.slice(1)}` : purlName;
    const dependencyClass = lockfileDependencyClass(entry);
    if (dependencyClass === "development") developmentComponentCount += 1;
    else productionComponentCount += 1;
    const component = {
      type: "library",
      name: purlName,
      version: entry.version,
      purl: `pkg:npm/${encodedName}@${entry.version}`,
      properties: [{ name: SBOM_PROPERTY_NAMES.lockfileDependencyClass, value: dependencyClass }]
    };
    const sha512 = integritySha512Hex(entry.integrity);
    if (sha512 !== undefined) component.hashes = [{ alg: "SHA-512", content: sha512 }];
    components.push(component);
  }
  components.sort((left, right) => left.purl.localeCompare(right.purl));

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${options.serialNumber ?? randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: options.timestamp ?? new Date().toISOString(),
      component: {
        type: "application",
        name: packageJson.name,
        version: packageJson.version
      },
      properties: [
        { name: SBOM_PROPERTY_NAMES.inventoryScope, value: SBOM_INVENTORY_SCOPE },
        { name: SBOM_PROPERTY_NAMES.inventorySource, value: "package-lock.json" },
        { name: SBOM_PROPERTY_NAMES.componentCount, value: String(components.length) },
        { name: SBOM_PROPERTY_NAMES.productionComponentCount, value: String(productionComponentCount) },
        { name: SBOM_PROPERTY_NAMES.developmentComponentCount, value: String(developmentComponentCount) }
      ]
    },
    components
  };
}

export async function writeSbomExclusive(out, sbom) {
  await writeFile(out, `${JSON.stringify(sbom, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const expectedName = `stinky-cobbler-${packageJson.version}.sbom.cyclonedx.json`;
  const out = path.resolve(root, args.get("--out") ?? expectedName);
  if (out !== path.join(root, expectedName)) throw new Error(`SBOM output must use the exact repository-root filename ${expectedName}.`);
  const sbom = buildSbom(packageJson, lockfile);
  await writeSbomExclusive(out, sbom);
  const inventoryProperties = Object.fromEntries(sbom.metadata.properties.map(({ name, value }) => [name, value]));
  console.log(JSON.stringify({
    valid: true,
    out,
    inventoryScope: inventoryProperties[SBOM_PROPERTY_NAMES.inventoryScope],
    components: sbom.components.length,
    lockfileProductionComponents: Number(inventoryProperties[SBOM_PROPERTY_NAMES.productionComponentCount]),
    lockfileDevelopmentComponents: Number(inventoryProperties[SBOM_PROPERTY_NAMES.developmentComponentCount])
  }, null, 2));
}

function parseArgs(argv) {
  if (argv.length === 0) return new Map();
  if (argv.length === 2 && argv[0] === "--out" && argv[1]?.length > 0) return new Map([["--out", argv[1]]]);
  throw new Error("Usage: node scripts/generate-sbom.mjs [--out <exact-versioned-filename>]");
}

if (isDirectInvocation(import.meta.url)) {
  await main();
}
