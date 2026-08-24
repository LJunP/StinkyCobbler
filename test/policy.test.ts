import { describe, expect, it } from "vitest";
import { evaluateLease, evaluateTask } from "../src/policy/evaluate.js";
import { assertTransition } from "../src/domain/task-state.js";

const task = { id: "task-1", workspaceId: "ws", goal: "Test", requestedOutputs: ["document"], riskLevel: "L0" as const, state: "DRAFT" as const };
const lease = { id: "lease-1", taskId: "task-1", agentId: "agent", role: "scout", capability: "repository-read", level: "L0" as const, workspace: "ws", readScope: ["docs"], writeSet: [], issuedAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", maxToolCalls: 1, status: "active" as const };

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe("policy", () => {
  it("requires approval for L2 tasks", () => expect(evaluateTask({ ...task, riskLevel: "L2" })).toMatchObject({ allowed: false, code: "APPROVAL_REQUIRED" }));
  it("rejects a new capability use immediately after its Lease expires", () => {
    const decision = evaluateLease({ ...lease, expiresAt: minutesAgo(2) }, { taskId: "task-1", role: "scout", workspace: "ws", capability: "repository-read" });
    expect(decision).toMatchObject({ allowed: false, code: "LEASE_EXPIRED" });
  });
  it("still rejects a mismatched Task before reporting Lease expiry", () => {
    expect(evaluateLease({ ...lease, expiresAt: minutesAgo(2) }, { taskId: "other-task", role: "scout", workspace: "ws", capability: "repository-read" })).toMatchObject({ allowed: false, code: "LEASE_TASK_MISMATCH" });
  });
  it("permits only early task transitions", () => {
    expect(() => assertTransition("DRAFT", "SCOPED")).not.toThrow();
    expect(() => assertTransition("DESIGNED", "DONE")).toThrow(/cannot transition/);
    expect(() => assertTransition("DONE", "REWORK")).toThrow(/cannot transition/);
    expect(() => assertTransition("CANCELLED", "BLOCKED")).toThrow(/cannot transition/);
  });
});
