import path from "node:path";

/** Repository or installed-package root. src/io and dist/io both sit two levels below it. */
export const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Frozen 2.x data shipped under resources/gate/ (STANDARDS C11). */
export function gateResource(root: string, ...segments: string[]): string {
  return path.join(root, "resources", "gate", ...segments);
}

/** Package-relative resources/gate path. The resources segment is spelled only here (STANDARDS C11). */
export function gateResourceRelative(...segments: string[]): string {
  return path.join("resources", "gate", ...segments);
}

/** 3.x data shipped under resources/toolkit/. */
export function toolkitResource(root: string, ...segments: string[]): string {
  return path.join(root, "resources", "toolkit", ...segments);
}
