import type { Pack, TaskCharter } from "../contracts/types.js";

export interface Recommendation {
  minimalDag: string[];
  gates: string[];
  requiresHumanChoice: true;
  reasons: string[];
}

export function recommendTask(task: Pick<TaskCharter, "riskLevel" | "requestedOutputs" | "packs">, packs: Map<string, Pack>): Recommendation {
  const selected = task.packs ?? [];
  const hasSoftware = selected.includes("software-engineering") || task.requestedOutputs.includes("code-change");
  const roles = hasSoftware ? ["planner", "architect", "builder", "testwright", "reviewer", "verifier", "scribe"] : ["planner", "producer", "reviewer", "scribe"];
  const reasons: string[] = [];
  if (hasSoftware) reasons.push("Software-oriented output requires design, independent review, and verification.");
  if (task.riskLevel === "L2" || task.riskLevel === "L3") {
    roles.splice(Math.max(1, roles.length - 2), 0, "sentinel");
    reasons.push("L2/L3 risk requires security and approval review.");
  }
  const qualityRules = selected.flatMap((id) => packs.get(id)?.qualityRules ?? []);
  if (qualityRules.some((rule) => /transaction|cache|queue|state/.test(rule))) roles.splice(roles.indexOf("reviewer"), 0, "reliability");
  return { minimalDag: [...new Set(roles)], gates: ["Charter", "Design", "Write", "IndependentReview", "Evidence", "HumanApproval", "Archive"], requiresHumanChoice: true, reasons };
}
