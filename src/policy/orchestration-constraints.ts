import { createHash } from "node:crypto";
import type { Artifact, Defect, OrchestrationRun, ReviewRecord, SubtaskPackage } from "../contracts/orchestration.js";

/**
 * 2.0 global constraint engine: budget / oscillation / regression / scope.
 * Pure functions — all rules are engine-computed facts, never LLM judgment.
 */

/** Budget: the run exceeded its global round cap (budget accumulates across rounds, never resets). */
export function exceedsRoundBudget(run: OrchestrationRun): boolean {
  return run.round >= run.budget.maxRounds;
}

/** Budget: the run exceeded its global token cap. */
export function exceedsTokenBudget(run: OrchestrationRun): boolean {
  return run.budget.usedTokens > run.budget.maxSubtaskTokens;
}

/** Budget: a subtask used up its retries. */
export function retriesExhausted(subtask: SubtaskPackage): boolean {
  // retriesUsed counts rejected executions, including the initial attempt.
  // maxRetries is the number of rework executions allowed after that initial
  // rejection, so exhaustion starts only when rejections exceed the cap.
  return subtask.retriesUsed > subtask.maxRetries;
}

/** Defect fingerprint: content hash of (location + problem + suggestion) — engine-computed, stable across rounds. */
export function defectFingerprint(defect: Defect): string {
  return createHash("sha256").update(`${defect.location}\n${defect.problem}\n${defect.suggestion}`, "utf8").digest("hex");
}

/**
 * Oscillation: the same defect fingerprint appears in >= threshold reviews of the same subtask
 * (across rounds) — the worker is going in circles; escalate instead of retrying forever.
 * Threshold is tighten-only (config rejects values above 2); default 2.
 */
export function oscillationDetected(reviews: ReviewRecord[], subtaskRef: string, threshold = 2): boolean {
  const fingerprints = new Map<string, number>();
  for (const review of reviews) {
    if (review.subtaskRef !== subtaskRef) continue;
    for (const defect of review.defects) {
      const fp = defectFingerprint(defect);
      fingerprints.set(fp, (fingerprints.get(fp) ?? 0) + 1);
      if (fingerprints.get(fp)! >= threshold) return true;
    }
  }
  return false;
}

/**
 * Regression: the most recent review score of a subtask is lower than the previous
 * round's score (monotonic decline) — the worker is making it worse; escalate.
 */
export function regressionDetected(reviews: ReviewRecord[], subtaskRef: string): boolean {
  const scored = reviews
    .filter((review) => review.subtaskRef === subtaskRef)
    .sort((left, right) => left.round - right.round);
  if (scored.length < 2) return false;
  const last = scored[scored.length - 1];
  const previous = scored[scored.length - 2];
  if (last === undefined || previous === undefined) return false;
  return last.score < previous.score;
}

/** Scope: an artifact path must be inside the subtask scope whitelist (workspace-relative prefix match). */
export function artifactInScope(scope: string[], path: string): boolean {
  const normalized = path.replace(/^\.\//, "").replace(/[\\/]+$/, "");
  return scope.some((prefix) => {
    const p = prefix.replace(/^\.\//, "").replace(/[\\/]+$/, "");
    return normalized === p || normalized.startsWith(`${p}/`) || p === ".";
  });
}

/** Scope violation: artifact path outside the subtask scope. */
export function scopeViolation(subtask: SubtaskPackage, artifact: Artifact): boolean {
  if (artifact.kind === "summary" || artifact.kind === "evidence") return false;
  return !artifactInScope(subtask.scope, artifact.path);
}

export interface ConstraintDecision {
  action: "continue" | "escalate" | "degrade" | "fail";
  code: "OSCILLATION" | "REGRESSION" | "ROUND_BUDGET" | "TOKEN_BUDGET" | "RETRIES_EXHAUSTED" | "SCOPE_VIOLATION" | null;
  detail: string;
}

/** Evaluates all constraint classes for a review decision. Hard scope/budget/retry failures take precedence over convergence escalation. */
export function evaluateConstraints(input: {
  run: OrchestrationRun;
  subtask: SubtaskPackage;
  reviews: ReviewRecord[];
  artifact?: Artifact;
  /** Tighten-only oscillation threshold (default 2); config rejects values above 2. */
  oscillationThreshold?: number;
}): ConstraintDecision {
  const { run, subtask, reviews, artifact, oscillationThreshold } = input;

  if (artifact !== undefined && scopeViolation(subtask, artifact)) {
    return { action: "fail", code: "SCOPE_VIOLATION", detail: `Artifact ${artifact.artifactId} path ${artifact.path} is outside subtask scope.` };
  }
  if (exceedsRoundBudget(run)) {
    return { action: "fail", code: "ROUND_BUDGET", detail: `Run exceeded maxRounds ${run.budget.maxRounds}.` };
  }
  if (exceedsTokenBudget(run)) {
    return { action: "fail", code: "TOKEN_BUDGET", detail: `Run exceeded maxSubtaskTokens ${run.budget.maxSubtaskTokens}.` };
  }
  if (retriesExhausted(subtask) && subtask.status === "REJECTED") {
    return {
      action: subtask.critical === true || run.failFast === true ? "fail" : "degrade",
      code: "RETRIES_EXHAUSTED",
      detail: `Subtask ${subtask.subtaskId} exhausted its retries${subtask.critical === true ? " (critical)" : run.failFast === true ? " (fail-fast run)" : ""}.`
    };
  }
  if (oscillationDetected(reviews, subtask.subtaskId, oscillationThreshold)) {
    return { action: "escalate", code: "OSCILLATION", detail: `Same defect fingerprint repeated across reviews of ${subtask.subtaskId}.` };
  }
  if (regressionDetected(reviews, subtask.subtaskId)) {
    return { action: "escalate", code: "REGRESSION", detail: `Review score declined across rounds for ${subtask.subtaskId}.` };
  }
  return { action: "continue", code: null, detail: "No constraint violated." };
}
