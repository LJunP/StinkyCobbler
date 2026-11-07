import { describe, expect, it } from "vitest";
import {
  contentFindings,
  formatResult,
  repositoryForbiddenFindings,
  untrackedStatusLines,
  workingTreeFailure
} from "../../scripts/audit-release.mjs";

describe("audit release formatting", () => {
  it("prints one PASS or FAIL line", () => {
    expect(formatResult("repo guards", true)).toBe("PASS repo guards");
    expect(formatResult("repo guards", false, "exit 1")).toBe("FAIL repo guards: exit 1");
  });
});

describe("audit release working tree", () => {
  it("rejects porcelain lines that start with ??", () => {
    const porcelain = " M src/a.ts\n?? junk.txt\n?? other.ts\n";
    expect(untrackedStatusLines(porcelain)).toEqual(["?? junk.txt", "?? other.ts"]);
    expect(untrackedStatusLines("M  src/a.ts\n")).toEqual([]);
    expect(workingTreeFailure("M  src/a.ts\n", [], [])).toBe("");
    expect(workingTreeFailure(porcelain, ["junk.txt", "other.ts"], ["tmp/empty"])).toBe(
      "untracked status: ?? junk.txt, ?? other.ts; untracked files: junk.txt, other.ts; empty directories: tmp/empty"
    );
  });
});

describe("audit release secret scan", () => {
  const token = ["npm", "_abcdefghijklmnopqrstuvwxyz1234567890"].join("");

  it("reports a pattern name and not the matched value", () => {
    const findings = contentFindings([{ path: "docs/a.md", text: `token=${token}` }], new Set());
    expect(findings).toEqual(["docs/a.md (npm token)"]);
    expect(findings.join("\n")).not.toContain(token);
  });

  it("skips the package-smoke fixture file and still flags other copies", () => {
    const fixture = { path: "test/scripts/package-smoke-contract.test.ts", text: `token=${token}` };
    expect(contentFindings([fixture])).toEqual([]);
    expect(contentFindings([fixture], new Set())).toEqual(["test/scripts/package-smoke-contract.test.ts (npm token)"]);
  });

  it("reports secret-shaped paths and ignores the pack layout denylist", () => {
    expect(repositoryForbiddenFindings(["src/app/a.ts", ".npmrc", "secrets.json", "keys/release.pem"])).toEqual([
      "secrets.json (forbidden path)",
      "keys/release.pem (forbidden path)"
    ]);
  });
});
