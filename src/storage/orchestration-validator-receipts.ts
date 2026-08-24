import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import type { ValidatorArtifactObservation, ValidatorReceipt } from "../contracts/orchestration.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile } from "./workspace.js";

const DIRECTORY = "orchestration";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ValidatorExecutionContext {
  runRef: string;
  subtaskRef: string;
  reviewRef: string;
  round: number;
  attempt: number;
  artifactObservations: readonly ValidatorArtifactObservation[];
}

export interface RegisteredOrchestrationValidator {
  id: string;
  version: string;
  execute(context: Readonly<ValidatorExecutionContext>): Promise<{ passed: boolean; detail: string }> | { passed: boolean; detail: string };
}

export interface PrepareValidatorReceiptOptions {
  createdAt?: string;
  storageBoundary?: ValidatorReceipt["storageBoundary"];
}

const validators = new Map<string, RegisteredOrchestrationValidator>();

/**
 * Code-level registration only: review JSON cannot add, replace, or report a validator result.
 * The built-in byte validator is always registered by this module.
 */
export function registerOrchestrationValidator(validator: RegisteredOrchestrationValidator): void {
  if (!ID_PATTERN.test(validator.id) || !validator.version.trim() || validator.version.length > 64) {
    throw validatorError("VALIDATOR_REGISTRATION_INVALID", "Validator id/version is invalid.", { validatorId: validator.id });
  }
  if (validators.has(validator.id)) {
    throw validatorError("VALIDATOR_ALREADY_REGISTERED", "Validator id is already registered and cannot be replaced at runtime.", { validatorId: validator.id });
  }
  validators.set(validator.id, validator);
}

export function listOrchestrationValidators(): Array<{ id: string; version: string }> {
  return [...validators.values()].map(({ id, version }) => ({ id, version })).sort((left, right) => left.id.localeCompare(right.id));
}

/** Executes every engine-registered validator and returns deterministic immutable receipts without writing them. */
export async function prepareRegisteredValidatorReceipts(
  schemas: SchemaRegistry,
  context: ValidatorExecutionContext,
  options: PrepareValidatorReceiptOptions = {}
): Promise<ValidatorReceipt[]> {
  if (validators.size === 0) throw validatorError("VALIDATOR_REGISTRY_EMPTY", "At least one engine validator must be registered.");
  const frozenContext = Object.freeze({
    ...context,
    artifactObservations: Object.freeze(context.artifactObservations.map((observation) => Object.freeze({ ...observation })))
  });
  const receipts: ValidatorReceipt[] = [];
  const createdAt = options.createdAt ?? new Date().toISOString();
  for (const validator of [...validators.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    let status: ValidatorReceipt["status"];
    let detail: string;
    try {
      const outcome = await validator.execute(frozenContext);
      status = outcome.passed ? "PASSED" : "FAILED";
      detail = outcome.detail;
    } catch (error: unknown) {
      status = "ERROR";
      detail = error instanceof Error ? `Validator execution error: ${error.message}` : "Validator execution error.";
    }
    if (!detail.trim()) detail = status === "PASSED" ? "Validator passed." : "Validator did not pass.";
    const receipt: ValidatorReceipt = {
      version: 1,
      receiptId: validatorReceiptId(context.reviewRef, validator.id, validator.version),
      source: "ENGINE_EXECUTED",
      validatorId: validator.id,
      validatorVersion: validator.version,
      status,
      detail: detail.slice(0, 1024),
      runRef: context.runRef,
      subtaskRef: context.subtaskRef,
      reviewRef: context.reviewRef,
      round: context.round,
      attempt: context.attempt,
      artifactObservations: context.artifactObservations.map((observation) => ({ ...observation })),
      createdAt,
      storageBoundary: options.storageBoundary ?? "JOURNALED_TRANSACTION"
    };
    schemas.validate("orchestration-validator-receipt", receipt);
    receipts.push(receipt);
  }
  return receipts;
}

/** Compatibility path for callers that need independent receipt persistence without a surrounding transaction. */
export async function executeRegisteredValidators(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  context: ValidatorExecutionContext
): Promise<ValidatorReceipt[]> {
  await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
  const receipts = await prepareRegisteredValidatorReceipts(schemas, context, { storageBoundary: "MULTI_FILE_NON_TRANSACTIONAL" });
  for (const receipt of receipts) await persistValidatorReceipt(workspace, receipt);
  return receipts;
}

/** Deterministic identity used by journal recovery for a validator/review binding. */
export function validatorReceiptId(reviewRef: string, validatorId: string, validatorVersion: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["orchestration-validator-receipt-v1", reviewRef, validatorId, validatorVersion]))
    .digest("hex");
  return `validator-receipt-${digest.slice(0, 48)}`;
}

export async function persistValidatorReceipt(workspace: LocalWorkspace, receipt: ValidatorReceipt): Promise<ValidatorReceipt> {
  await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
  try {
    await createWorkspaceJson(workspace, receiptFile(receipt.receiptId), receipt);
    return receipt;
  } catch (error: unknown) {
    if (!isCode(error, "EEXIST")) throw error;
    const existing = await getValidatorReceipt(workspace, receipt.receiptId);
    if (canonical(existing) !== canonical(receipt)) {
      throw validatorError("VALIDATOR_RECEIPT_CONFLICT", "A deterministic validator receipt ID already stores different bytes.", {
        receiptId: receipt.receiptId
      });
    }
    return existing;
  }
}

export async function getValidatorReceipt(workspace: LocalWorkspace, receiptId: string): Promise<ValidatorReceipt> {
  assertId(receiptId);
  try {
    const parsed: unknown = JSON.parse(await readFile(await workspaceFile(workspace, receiptFile(receiptId)), "utf8"));
    (await defaultSchemaRegistry()).validate("orchestration-validator-receipt", parsed);
    const receipt = parsed as ValidatorReceipt;
    if (receipt.receiptId !== receiptId) {
      throw validatorError("VALIDATOR_RECEIPT_ID_MISMATCH", "Stored ValidatorReceipt ID does not match its canonical lookup ID.", {
        receiptId,
        storedReceiptId: receipt.receiptId
      });
    }
    return receipt;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw validatorError("VALIDATOR_RECEIPT_NOT_FOUND", "Validator receipt does not exist.", { receiptId });
    if (error instanceof SyntaxError) throw validatorError("VALIDATOR_RECEIPT_INVALID", "Stored validator receipt contains invalid JSON.", { receiptId });
    throw error;
  }
}

export function assertValidatorReceiptBinding(receipt: ValidatorReceipt, expected: {
  runRef: string;
  subtaskRef: string;
  reviewRef: string;
  attempt: number;
}): void {
  if (
    receipt.source !== "ENGINE_EXECUTED" ||
    receipt.runRef !== expected.runRef ||
    receipt.subtaskRef !== expected.subtaskRef ||
    receipt.reviewRef !== expected.reviewRef ||
    receipt.attempt !== expected.attempt
  ) {
    throw validatorError("VALIDATOR_RECEIPT_BINDING_MISMATCH", "Validator receipt is not bound to the supplied run/subtask/review generation.", {
      receiptId: receipt.receiptId,
      expected
    });
  }
}

registerOrchestrationValidator({
  id: "artifact-bytes",
  version: "1",
  execute(context) {
    if (context.artifactObservations.length === 0) {
      return { passed: false, detail: "No current-attempt file artifact bytes were available to validate." };
    }
    const mismatches = context.artifactObservations.filter((observation) => observation.expectedHash !== observation.observedHash);
    return mismatches.length === 0
      ? { passed: true, detail: `Recomputed ${context.artifactObservations.length} current-attempt file artifact hash(es).` }
      : { passed: false, detail: `${mismatches.length} current-attempt artifact hash(es) did not match.` };
  }
});

function receiptFile(receiptId: string): string { return path.join(DIRECTORY, `${receiptId}.json`); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function assertId(id: string): void { if (!ID_PATTERN.test(id)) throw validatorError("VALIDATOR_RECEIPT_ID_INVALID", "Validator receipt id is invalid.", { receiptId: id }); }
function validatorError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details);
}
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
