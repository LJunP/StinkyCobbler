import { describe, expect, it } from "vitest";
import { evaluateLease, evaluateTask } from "../src/policy/evaluate.js";
import { assertTransition } from "../src/domain/task-state.js";

const task = { id: "task-1", workspaceId: "ws", goal: "Test", requestedOutputs: ["document"], riskLevel: "L0" as const, state: "DRAFT" as const };
const lease = { id: "lease-1", taskId: "task-1", agentId: "agent", role: "scout", capability: "repository-read", level: "L0" as const, workspace: "ws", readScope: ["docs"], writeSet: [], issuedAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", maxToolCalls: 1, status: "active" as const };

/** An expiry two minutes in the past: inside the fixed 15-minute grace window. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe("policy", () => {
  it("requires approval for L2 tasks", () => expect(evaluateTask({ ...task, riskLevel: "L2" })).toMatchObject({ allowed: false, code: "APPROVAL_REQUIRED" }));
  it("rejects expired leases beyond the grace period", () => expect(evaluateLease({ ...lease, expiresAt: "2020-01-01T00:00:00Z" }, { taskId: "task-1", role: "scout", workspace: "ws", capability: "repository-read" })).toMatchObject({ allowed: false, code: "LEASE_EXPIRED" }));
  it("admits an expired lease within the grace period for the same task", () => {
    const decision = evaluateLease({ ...lease, expiresAt: minutesAgo(2) }, { taskId: "task-1", role: "scout", workspace: "ws", capability: "repository-read" });
    expect(decision.allowed).toBe(true);
    expect(decision.reasons[0]).toContain("grace period");
  });
  it("still denies the grace-admitted lease when a later gate fails", () => {
    // writeSet empty on a repository-write lease must fail even within the grace window.
    const writeLease = { ...lease, capability: "repository-write" as const, writeSet: [], expiresAt: minutesAgo(2) };
    expect(evaluateLease(writeLease, { taskId: "task-1", role: "scout", workspace: "ws", capability: "repository-write" })).toMatchObject({ allowed: false, code: "WRITE_SET_EMPTY" });
    // call-limit gate still applies within the grace window.
    expect(evaluateLease({ ...lease, expiresAt: minutesAgo(2), maxToolCalls: 0 }, { taskId: "task-1", role: "scout", workspace: "ws", capability: "repository-read", toolCallsUsed: 0 })).toMatchObject({ allowed: false, code: "LEASE_CALL_LIMIT" });
  });
  it("never grace-admits a different task", () => {
    expect(evaluateLease({ ...lease, expiresAt: minutesAgo(2) }, { taskId: "other-task", role: "scout", workspace: "ws", capability: "repository-read" })).toMatchObject({ allowed: false, code: "LEASE_TASK_MISMATCH" });
  });
  it("permits only early task transitions", () => {
    expect(() => assertTransition("DRAFT", "SCOPED")).not.toThrow();
    expect(() => assertTransition("DESIGNED", "DONE")).toThrow(/not authorized/);
  });
});
