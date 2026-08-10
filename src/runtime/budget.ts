import { performance } from "node:perf_hooks";
import { StinkyCobblerError, ExitCode } from "../errors.js";
import type { RuntimeBudget, RuntimeBudgetUsage } from "../contracts/types.js";

export interface BudgetMeasurement {
  files?: string[];
  bytes?: number;
  outputBytes?: number;
}

export interface BudgetReservation {
  commit(measurement?: BudgetMeasurement): RuntimeBudgetUsage;
  release(): RuntimeBudgetUsage;
}

export interface BudgetHandle {
  readonly signal: AbortSignal;
  beginTurn(): BudgetReservation;
  reserveToolCall(): BudgetReservation;
  snapshot(): RuntimeBudgetUsage;
  check(): void;
  cancel(): void;
}

export interface BudgetSupervisorOptions {
  now?: () => number;
  usage?: RuntimeBudgetUsage;
}

export class BudgetSupervisor implements BudgetHandle {
  private readonly clock: () => number;
  private readonly startedAt: number;
  private readonly controller = new AbortController();
  private usage: RuntimeBudgetUsage;
  private readonly files = new Set<string>();
  private reservedToolCalls = 0;
  private reservedTurns = 0;

  public constructor(private readonly budget: RuntimeBudget, options: BudgetSupervisorOptions = {}) {
    this.clock = options.now ?? (() => performance.now());
    this.startedAt = this.clock();
    this.usage = { turns: options.usage?.turns ?? 0, toolCalls: options.usage?.toolCalls ?? 0, files: options.usage?.files ?? 0, bytes: options.usage?.bytes ?? 0, outputBytes: options.usage?.outputBytes ?? 0 };
    this.check();
  }

  public get signal(): AbortSignal { return this.controller.signal; }

  public beginTurn(): BudgetReservation {
    this.check();
    this.assertLimit("maxTurns", (this.usage.turns ?? 0) + this.reservedTurns + 1);
    this.reservedTurns += 1;
    return this.reservation("turn");
  }

  public reserveToolCall(): BudgetReservation {
    this.check();
    this.assertLimit("maxToolCalls", (this.usage.toolCalls ?? 0) + this.reservedToolCalls + 1);
    this.reservedToolCalls += 1;
    return this.reservation("tool");
  }

  public snapshot(): RuntimeBudgetUsage {
    const minutes = Math.max(0, Math.floor((this.clock() - this.startedAt) / 60_000));
    return { ...this.usage, minutes };
  }

  public check(): void {
    if (this.controller.signal.aborted) throw budgetError("RUNTIME_CANCELLED", "Runtime has been cancelled.");
    if (this.budget.maxMinutes !== undefined && this.clock() - this.startedAt >= this.budget.maxMinutes * 60_000) {
      this.controller.abort();
      throw budgetError("RUNTIME_DEADLINE_EXCEEDED", "Runtime budget deadline has expired.");
    }
  }

  public cancel(): void { this.controller.abort(); }

  private reservation(kind: "turn" | "tool"): BudgetReservation {
    let settled = false;
    return {
      commit: (measurement = {}) => {
        if (settled) return this.snapshot();
        settled = true;
        if (kind === "turn") this.reservedTurns -= 1;
        else this.reservedToolCalls -= 1;
        const previousUsage = this.usage;
        const previousFiles = [...this.files];
        const bytes = measurement.bytes ?? 0;
        const outputBytes = measurement.outputBytes ?? 0;
        const newFiles = [...new Set(measurement.files ?? [])].filter((file) => !this.files.has(file));
        const nextUsage: RuntimeBudgetUsage = {
          turns: (this.usage.turns ?? 0) + (kind === "turn" ? 1 : 0),
          toolCalls: (this.usage.toolCalls ?? 0) + (kind === "tool" ? 1 : 0),
          files: this.files.size + newFiles.length,
          bytes: (this.usage.bytes ?? 0) + bytes,
          outputBytes: (this.usage.outputBytes ?? 0) + outputBytes
        };
        for (const file of newFiles) this.files.add(file);
        this.usage = nextUsage;
        try {
          this.check();
          this.assertLimit("maxFiles", nextUsage.files ?? 0);
          this.assertLimit("maxBytes", nextUsage.bytes ?? 0);
          this.assertLimit("maxOutputBytes", nextUsage.outputBytes ?? 0);
        } catch (error) {
          this.usage = previousUsage;
          this.files.clear();
          for (const file of previousFiles) this.files.add(file);
          throw error;
        }
        return this.snapshot();
      },
      release: () => {
        if (!settled) {
          settled = true;
          if (kind === "turn") this.reservedTurns -= 1;
          else this.reservedToolCalls -= 1;
        }
        return this.snapshot();
      }
    };
  }

  private assertLimit(name: keyof RuntimeBudget, value: number): void {
    const limit = this.budget[name];
    if (limit !== undefined && value > limit) throw budgetError("RUNTIME_BUDGET_EXCEEDED", `${name} runtime budget exceeded.`);
  }
}

function budgetError(code: string, message: string): StinkyCobblerError { return new StinkyCobblerError(code, ExitCode.POLICY_DENIED, message); }
