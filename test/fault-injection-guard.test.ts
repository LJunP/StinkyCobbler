import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { injectTaskTransitionFaultForTesting } from "../src/storage/task-transitions.js";
import { injectRuntimeFinalizationFaultOnceForTest } from "../src/storage/runtime-finalization.js";
import { initWorkspace } from "../src/storage/workspace.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function withNodeEnv<T>(value: string | undefined, run: () => T): Promise<T> {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = value;
  try { return await run(); } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
}

describe("fault-injection hooks refuse to arm outside the test runner", () => {
  it("rejects task transition fault injection when NODE_ENV is not test", async () => {
    const workspace = await initWorkspace(await mkdtemp(path.join(os.tmpdir(), "stinky-fault-guard-"))); roots.push(workspace.root);
    await withNodeEnv("production", () => {
      expect(() => injectTaskTransitionFaultForTesting(workspace, "after-prepare")).toThrow(expect.objectContaining({ code: "TASK_TRANSITION_TEST_FAULT_DENIED" }));
    });
  });

  it("rejects runtime finalization fault injection when NODE_ENV is not test", async () => {
    const workspace = await initWorkspace(await mkdtemp(path.join(os.tmpdir(), "stinky-fault-guard-"))); roots.push(workspace.root);
    await withNodeEnv("production", () => {
      expect(() => injectRuntimeFinalizationFaultOnceForTest(workspace, "after-prepare")).toThrow(expect.objectContaining({ code: "RUNTIME_FINALIZATION_TEST_FAULT_DENIED" }));
    });
  });
});
