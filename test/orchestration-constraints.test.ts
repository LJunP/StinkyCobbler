import { describe, expect, it } from "vitest";
import {
  artifactInScope, defectFingerprint, evaluateConstraints, exceedsRoundBudget, exceedsTokenBudget,
  oscillationDetected, regressionDetected, retriesExhausted, scopeViolation
} from "../src/policy/orchestration-constraints.js";
import type { Artifact, OrchestrationRun, ReviewRecord, SubtaskPackage } from "../src/contracts/orchestration.js";

const run: OrchestrationRun = {
  version: 1, runId: "run-1", contractRef: "contract-1", status: "RUNNING", round: 1,
  budget: { maxRounds: 5, maxRetriesPerSubtask: 2, maxSubtaskTokens: 1000, usedTokens: 100 },
  subtasks: [], artifacts: [], reviews: [], goalConsistency: [], createdAt: "2026-08-11T00:00:00Z"
};

const subtask: SubtaskPackage = {
  version: 1, subtaskId: "subtask-1", contractRef: "contract-1", runRef: "run-1", goal: "g",
  inputArtifacts: [], acceptanceCriteria: ["a"], scope: ["docs"], maxRetries: 2, capabilities: ["repository-read"],
  status: "REJECTED", round: 1, retriesUsed: 1, dependsOn: [], createdAt: "2026-08-11T00:00:00Z"
};

function review(round: number, score: number, defects: { location: string; problem: string }[]): ReviewRecord {
  return {
    version: 1, reviewId: `review-${round}`, runRef: "run-1", subtaskRef: "subtask-1", round,
    decision: defects.length > 0 ? "REJECTED" : "ACCEPTED",
    criteriaResults: [], defects: defects.map((d) => ({ ...d, suggestion: "fix" })), score, reason: "r",
    validatorEvidence: [], createdAt: "2026-08-11T00:00:00Z", reviewedBy: "host"
  };
}

describe("orchestration constraint engine", () => {
  it("detects round and token budget exhaustion (global, never resets)", () => {
    expect(exceedsRoundBudget({ ...run, round: 5 })).toBe(false);
    expect(exceedsRoundBudget({ ...run, round: 6 })).toBe(true);
    expect(exceedsTokenBudget({ ...run, budget: { ...run.budget, usedTokens: 1001 } })).toBe(true);
  });

  it("detects retry exhaustion", () => {
    expect(retriesExhausted({ ...subtask, retriesUsed: 1 })).toBe(false);
    expect(retriesExhausted({ ...subtask, retriesUsed: 2 })).toBe(true);
  });

  it("detects oscillation: same defect fingerprint twice across rounds", () => {
    const same = review(1, 40, [{ location: "docs/a.md", problem: "missing section" }]);
    const again = review(2, 40, [{ location: "docs/a.md", problem: "missing section" }]);
    expect(oscillationDetected([same, again], "subtask-1")).toBe(true);
    const different = review(2, 40, [{ location: "docs/b.md", problem: "other issue" }]);
    expect(oscillationDetected([same, different], "subtask-1")).toBe(false);
  });

  it("detects regression: score declined across rounds", () => {
    expect(regressionDetected([review(1, 80, [])], "subtask-1")).toBe(false);
    expect(regressionDetected([review(1, 80, []), review(2, 70, [])], "subtask-1")).toBe(true);
    expect(regressionDetected([review(1, 70, []), review(2, 80, [])], "subtask-1")).toBe(false);
  });

  it("enforces scope prefix matching for artifacts", () => {
    expect(artifactInScope(["docs"], "docs/guide.md")).toBe(true);
    expect(artifactInScope(["docs"], "docs")).toBe(true);
    expect(artifactInScope(["docs"], "src/main.ts")).toBe(false);
    expect(artifactInScope(["."], "anything/file.md")).toBe(true);
  });

  it("flags scope violations on file artifacts", () => {
    const artifact: Artifact = { version: 1, artifactId: "artifact-1", runRef: "run-1", subtaskRef: "subtask-1", kind: "file", path: "src/main.ts", contentHash: "sha256:" + "a".repeat(64), round: 1, status: "VERIFIED", createdAt: "2026-08-11T00:00:00Z" };
    expect(scopeViolation(subtask, artifact)).toBe(true);
    expect(scopeViolation({ ...subtask, scope: ["src"] }, artifact)).toBe(false);
  });

  it("escalates on oscillation and regression; fails on budget; continues otherwise", () => {
    const oscillation = evaluateConstraints({ run, subtask, reviews: [review(1, 40, [{ location: "x", problem: "p" }]), review(2, 40, [{ location: "x", problem: "p" }])] });
    expect(oscillation).toMatchObject({ action: "escalate", code: "OSCILLATION" });
    const regression = evaluateConstraints({ run, subtask, reviews: [review(1, 80, []), review(2, 70, [])] });
    expect(regression).toMatchObject({ action: "escalate", code: "REGRESSION" });
    const budget = evaluateConstraints({ run: { ...run, round: 6 }, subtask, reviews: [] });
    expect(budget).toMatchObject({ action: "fail", code: "ROUND_BUDGET" });
    const exhausted = evaluateConstraints({ run, subtask: { ...subtask, retriesUsed: 2 }, reviews: [] });
    expect(exhausted).toMatchObject({ action: "fail", code: "RETRIES_EXHAUSTED" });
    const ok = evaluateConstraints({ run, subtask: { ...subtask, retriesUsed: 0 }, reviews: [] });
    expect(ok.action).toBe("continue");
  });

  it("produces stable defect fingerprints", () => {
    const a = defectFingerprint({ location: "docs/a.md", problem: "missing", suggestion: "add" });
    const b = defectFingerprint({ location: "docs/a.md", problem: "missing", suggestion: "add" });
    const c = defectFingerprint({ location: "docs/a.md", problem: "missing", suggestion: "different" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
