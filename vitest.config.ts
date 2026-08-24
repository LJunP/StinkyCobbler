import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The suite intentionally runs many fsync/rename/fault-recovery tests in
    // parallel. Keep their timeout portable across macOS/Linux/Windows CI;
    // tests that verify a tighter deadline set their own explicit timeout.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
