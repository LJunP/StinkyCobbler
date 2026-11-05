import { defineConfig } from "vitest/config";

// The suite intentionally runs many fsync/rename/fault-recovery tests in
// parallel. Keep their timeout portable across macOS/Linux/Windows CI;
// tests that verify a tighter deadline set their own explicit timeout.
const timeouts = { testTimeout: 30_000, hookTimeout: 30_000 };

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["test/setup/isolate-xdg.ts", "test/setup/isolate-git.ts"],
    ...timeouts,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.integration.test.ts"]
        }
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/**/*.integration.test.ts"],
          // Integration suites spawn dist/cli.js and dist/mcp-server.js. Rebuild
          // first when any build input is newer, so they never test stale bytes.
          globalSetup: ["test/setup/dist-freshness.ts"]
        }
      }
    ]
  }
});
