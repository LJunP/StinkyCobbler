import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHostConformance } from "../../src/hosts/conformance/run.js";
import { hostAdapters } from "../../src/hosts/registry.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("host conformance", () => {
  it.each(hostAdapters.map((adapter) => [adapter.id, adapter] as const))("%s passes the shared host checks", async (_id, adapter) => {
    const emptyHome = await mkdtemp(path.join(os.tmpdir(), "stinky-host-empty-"));
    const presentHome = await mkdtemp(path.join(os.tmpdir(), "stinky-host-present-"));
    const cwd = await mkdtemp(path.join(os.tmpdir(), "stinky-host-cwd-"));
    roots.push(emptyHome, presentHome, cwd);
    await mkdir(path.join(presentHome, adapter.presenceDirectory));

    expect(await runHostConformance(adapter, { emptyHome, presentHome, cwd })).toEqual([]);
  });
});
