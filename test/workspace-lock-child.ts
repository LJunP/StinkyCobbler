import { initWorkspace } from "../src/storage/workspace.js";
import { withWorkspaceLock } from "../src/storage/workspace-lock.js";

const [root, mode] = process.argv.slice(2);
if (!root || (mode !== "hold" && mode !== "once")) process.exit(2);
const workspace = await initWorkspace(root);
if (mode === "once") {
  await withWorkspaceLock(workspace, async () => process.stdout.write("acquired\n"), { waitMs: 100, pollMs: 5 });
} else {
  await withWorkspaceLock(workspace, async () => {
    process.stdout.write("ready\n");
    process.stdin.resume();
    await new Promise<void>((resolve) => process.stdin.once("data", () => { process.stdin.pause(); resolve(); }));
  }, { waitMs: 5_000, pollMs: 10 });
}
