import path from "node:path";
import { SchemaRegistry } from "./schema-registry.js";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
let registryPromise: Promise<SchemaRegistry> | undefined;

/**
 * Shared read-boundary registry for persisted workspace objects.  Storage
 * getters do not accept caller-supplied validators: every ordinary get/list
 * path validates bytes against the package's canonical schemas.
 */
export function defaultSchemaRegistry(): Promise<SchemaRegistry> {
  registryPromise ??= SchemaRegistry.create(PACKAGE_ROOT);
  return registryPromise;
}
