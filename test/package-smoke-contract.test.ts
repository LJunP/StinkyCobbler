import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  findForbiddenPackagePaths,
  findSensitiveContent,
  isolatedHostEnvironment,
  packageBinPath
} from "../scripts/package-smoke.mjs";
import { npmExecutable } from "../scripts/release-utils.mjs";

describe("package smoke portability and sensitivity gates", () => {
  it("selects the npm-generated .cmd shim on Windows", () => {
    expect(packageBinPath("C:\\tmp\\node_modules\\.bin", "stinky-cobbler", "win32"))
      .toBe(path.join("C:\\tmp\\node_modules\\.bin", "stinky-cobbler.cmd"));
    expect(packageBinPath("/tmp/node_modules/.bin", "stinky-cobbler", "linux"))
      .toBe(path.join("/tmp/node_modules/.bin", "stinky-cobbler"));
  });

  it("selects the platform npm executable used by release scripts", () => {
    expect(npmExecutable()).toBe(process.platform === "win32" ? "npm.cmd" : "npm");
  });

  it("isolates every home variable used by supported Node platforms", () => {
    const windows = isolatedHostEnvironment("C:\\isolated\\home", { PATH: "safe" }, "win32");
    expect(windows).toMatchObject({
      HOME: "C:\\isolated\\home",
      USERPROFILE: "C:\\isolated\\home",
      HOMEDRIVE: "C:",
      HOMEPATH: "\\isolated\\home"
    });

    const posix = isolatedHostEnvironment("/tmp/isolated-home", { PATH: "safe" }, "linux");
    expect(posix).toMatchObject({
      HOME: "/tmp/isolated-home",
      USERPROFILE: "/tmp/isolated-home",
      HOMEDRIVE: "",
      HOMEPATH: "/tmp/isolated-home"
    });
  });

  it("rejects control-plane state, credential names, and private material", () => {
    const forbidden = findForbiddenPackagePaths([
      "README.md",
      ".codex/skills/stinky-cobbler/SKILL.md",
      ".codex/auth.json",
      "session_index.jsonl",
      "nested/.env.production",
      "keys/release.pem"
    ]);
    expect(forbidden).toEqual([
      ".codex/auth.json",
      "session_index.jsonl",
      "nested/.env.production",
      "keys/release.pem"
    ]);
  });

  it("reports secret signatures and private workstation paths without echoing values", () => {
    expect(findSensitiveContent("docs/example.md", "token=npm_abcdefghijklmnopqrstuvwxyz1234567890"))
      .toEqual(["docs/example.md (npm token)"]);
    expect(findSensitiveContent("dist/map.js", "source=/Users/alice/private/project.ts"))
      .toEqual(["dist/map.js (private home path)"]);
    expect(findSensitiveContent("README.md", "Use ~/.zcode and never paste real credentials."))
      .toEqual([]);
  });
});
