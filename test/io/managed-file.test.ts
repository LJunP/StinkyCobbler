import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupPathFor, installManagedBytes, managedMetadataPath, readManagedMetadata } from "../../src/io/managed-file.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed file names", () => {
  it("keeps the 2.0.1 sidecar and backup filenames", () => {
    const target = "/tmp/demo/config.toml";
    const digest = "ab".repeat(32);
    expect(managedMetadataPath(target)).toBe("/tmp/demo/config.toml.stinky-cobbler-managed.json");
    expect(path.basename(backupPathFor(target, digest))).toBe(`config.toml.stinky-cobbler-backup-${digest}.bak`);
  });

  it("writes a sidecar that the reader still accepts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-managed-"));
    roots.push(root);
    const target = path.join(root, "config.toml");
    await installManagedBytes(target, "model = \"gpt\"\n", "2.0.2", "2.0.2");
    const metadata = await readManagedMetadata(target);
    expect(metadata?.version).toBe(1);
    expect(metadata?.productVersion).toBe("2.0.2");
    expect(await readFile(managedMetadataPath(target), "utf8")).toContain("\"version\": 1");
    expect(await readFile(target, "utf8")).toBe("model = \"gpt\"\n");
  });
});
