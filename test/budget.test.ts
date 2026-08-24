import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetSupervisor } from "../src/runtime/budget.js";

afterEach(() => { vi.useRealTimers(); });

function codeOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

describe("Runtime BudgetSupervisor", () => {
  it("enforces turns and tool-call reservations at exact boundaries", () => {
    const supervisor = new BudgetSupervisor({ maxTurns: 1, maxToolCalls: 1 });
    const turn = supervisor.beginTurn();
    const call = supervisor.reserveToolCall();
    expect(call.commit()).toMatchObject({ toolCalls: 1 });
    expect(turn.commit()).toMatchObject({ turns: 1 });
    expect(() => supervisor.beginTurn()).toThrowError(/maxTurns/);
    expect(() => supervisor.reserveToolCall()).toThrowError(/maxToolCalls/);
  });

  it("counts unique files but accumulates bytes and output bytes", () => {
    const supervisor = new BudgetSupervisor({ maxFiles: 2, maxBytes: 5, maxOutputBytes: 4 });
    const first = supervisor.reserveToolCall();
    expect(first.commit({ files: ["a.txt", "a.txt"], bytes: 3, outputBytes: 2 })).toMatchObject({ files: 1, bytes: 3, outputBytes: 2 });
    const second = supervisor.reserveToolCall();
    expect(second.commit({ files: ["a.txt", "b.txt"], bytes: 2, outputBytes: 2 })).toMatchObject({ files: 2, bytes: 5, outputBytes: 4 });
    const third = supervisor.reserveToolCall();
    expect(() => third.commit({ files: ["c.txt"] })).toThrowError(/maxFiles/);
    expect(supervisor.snapshot()).toMatchObject({ files: 2 });
  });

  it("does not oversell concurrent reservations", () => {
    const supervisor = new BudgetSupervisor({ maxToolCalls: 2 });
    const first = supervisor.reserveToolCall();
    const second = supervisor.reserveToolCall();
    expect(() => supervisor.reserveToolCall()).toThrowError(/maxToolCalls/);
    first.release();
    second.commit();
  });

  it("uses a monotonic clock for deadlines and cancellation", () => {
    let now = 10_000;
    const supervisor = new BudgetSupervisor({ maxMinutes: 1 }, { now: () => now });
    now += 59_999;
    expect(() => supervisor.check()).not.toThrow();
    now += 1;
    let deadlineError: unknown;
    try { supervisor.check(); } catch (error) { deadlineError = error; }
    expect(codeOf(deadlineError)).toBe("RUNTIME_DEADLINE_EXCEEDED");

    const cancelled = new BudgetSupervisor({});
    cancelled.cancel();
    expect(() => cancelled.check()).toThrowError(/cancelled/);
    expect(codeOf((() => { try { cancelled.check(); } catch (error) { return error; } })())).toBe("RUNTIME_CANCELLED");
  });

  it("actively aborts an in-flight operation when maxMinutes expires", async () => {
    vi.useFakeTimers();
    const supervisor = new BudgetSupervisor({ maxMinutes: 1 });
    let observedReason: unknown;
    supervisor.signal.addEventListener("abort", () => {
      observedReason = supervisor.signal.reason;
    }, { once: true });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(supervisor.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(supervisor.signal.aborted).toBe(true);
    expect(codeOf(observedReason)).toBe("RUNTIME_DEADLINE_EXCEEDED");
    expect(codeOf((() => { try { supervisor.check(); } catch (error) { return error; } })())).toBe("RUNTIME_DEADLINE_EXCEEDED");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the active deadline timer on cancellation and disposal", () => {
    vi.useFakeTimers();
    const cancelled = new BudgetSupervisor({ maxMinutes: 1 });
    expect(vi.getTimerCount()).toBe(1);
    cancelled.cancel();
    expect(vi.getTimerCount()).toBe(0);

    const disposed = new BudgetSupervisor({ maxMinutes: 1 });
    expect(vi.getTimerCount()).toBe(1);
    disposed.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(disposed.signal.aborted).toBe(false);
  });
});
