import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Extracts the SHA-512 digest from an npm integrity string (for example sha512-<base64>). */
function integritySha512(integrity) {
  if (typeof integrity !== "string") return undefined;
  const match = integrity.match(/^sha512-([A-Za-z0-9+/=]+)$/);
  return match?.[1] === undefined ? undefined : match[1];
}

/** Builds a CycloneDX 1.5 BOM from package-lock.json packages. */
export function buildSbom(packageJson, lockfile, options = {}) {
  const components = [];
  for (const [name, entry] of Object.entries(lockfile.packages ?? {})) {
    if (name === "") continue;
    const purlName = name.startsWith("node_modules/") ? name.slice("node_modules/".length) : name;
    if (typeof entry?.version !== "string") continue;
    const encodedName = purlName.startsWith("@") ? `%40${purlName.slice(1)}` : purlName;
    const component = {
      type: "library",
      name: purlName,
      version: entry.version,
      purl: `pkg:npm/${encodedName}@${entry.version}`
    };
    const sha512 = integritySha512(entry.integrity);
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
      }
    },
    components
  };
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
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const out = args.get("--out") ?? path.join(root, "sbom.cyclonedx.json");
  const sbom = buildSbom(packageJson, lockfile);
  await writeFile(out, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ valid: true, out, components: sbom.components.length }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
