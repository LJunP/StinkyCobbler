import { createHash } from "node:crypto";
import type { TaskCapsule } from "../contracts/types.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";

/**
 * Binds one Runtime execution identity to the complete admitted Capsule, the
 * selected executor, and the caller-ordered request sequence. Object key order
 * is normalized while array order remains significant.
 */
export function hashRuntimeExecutionRequest(
  capsule: TaskCapsule,
  executor: string,
  requests: readonly unknown[]
): string {
  const envelope = {
    domain: "stinky-cobbler.runtime-execution-request.v1",
    capsule,
    executor,
    requests
  };
  return `sha256:${createHash("sha256").update(canonical(envelope), "utf8").digest("hex")}`;
}

function canonical(value: unknown, ancestors: Set<object> = new Set()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidExecutionRequest("Runtime execution requests require finite JSON numbers.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw invalidExecutionRequest("Runtime execution requests must contain only JSON-compatible values.");
  }
  if (ancestors.has(value)) throw invalidExecutionRequest("Runtime execution requests cannot contain cyclic values.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, ancestors)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidExecutionRequest("Runtime execution requests must use plain JSON objects.");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function invalidExecutionRequest(message: string): StinkyCobblerError {
  return new StinkyCobblerError("RUNTIME_EXECUTION_REQUEST_INVALID", ExitCode.VALIDATION, message);
}
