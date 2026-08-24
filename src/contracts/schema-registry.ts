import { type ErrorObject, type ValidateFunction } from "ajv";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { StinkyCobblerError, ExitCode } from "../errors.js";

export type ContractKind = "task" | "task-transition" | "artifact" | "capsule" | "lease" | "lease-issuance" | "receipt" | "runtime-finalization" | "approval" | "audit" | "config" | "profile" | "pack" | "role" | "plugin" | "policy-decision" | "evidence-ref" | "agent-run" | "tool-call-record" | "plan" | "write-intent" | "orchestration-contract" | "orchestration-subtask" | "orchestration-artifact" | "orchestration-review" | "orchestration-run" | "orchestration-validator-receipt" | "orchestration-transaction" | "orchestration-policy" | "specialists-policy" | "templates-policy" | "contract-templates-policy" | "cancellation-fence" | "lease-usage" | "audit-outbox" | "docs-index" | "role-tools-policy" | "plugin-registry-policy";

interface CanonicalSchema {
  filename: string;
  expectedId: string;
}

const FILE_BY_KIND: Record<ContractKind, CanonicalSchema> = {
  task: { filename: "task.schema.json", expectedId: "https://stinkycobbler.dev/schemas/task.schema.json" },
  "task-transition": { filename: "task-transition.schema.json", expectedId: "https://stinkycobbler.dev/schemas/task-transition.schema.json" },
  artifact: { filename: "artifact.schema.json", expectedId: "https://stinkycobbler.dev/schemas/artifact.schema.json" },
  capsule: { filename: "task-capsule.schema.json", expectedId: "https://stinkycobbler.dev/schemas/task-capsule.schema.json" },
  lease: { filename: "capability-lease.schema.json", expectedId: "https://stinkycobbler.dev/schemas/capability-lease.schema.json" },
  "lease-issuance": { filename: "lease-issuance.schema.json", expectedId: "https://stinkycobbler.dev/schemas/lease-issuance.schema.json" },
  receipt: { filename: "agent-receipt.schema.json", expectedId: "https://stinkycobbler.dev/schemas/agent-receipt.schema.json" },
  "runtime-finalization": { filename: "runtime-finalization.schema.json", expectedId: "https://stinkycobbler.dev/schemas/runtime-finalization.schema.json" },
  approval: { filename: "approval.schema.json", expectedId: "https://stinkycobbler.dev/schemas/approval.schema.json" },
  audit: { filename: "audit-event.schema.json", expectedId: "https://stinkycobbler.dev/schemas/audit-event.schema.json" },
  config: { filename: "workspace-config.schema.json", expectedId: "https://stinkycobbler.dev/schemas/workspace-config.schema.json" },
  profile: { filename: "profile.schema.json", expectedId: "https://stinkycobbler.dev/schemas/profile.schema.json" },
  pack: { filename: "pack.schema.json", expectedId: "https://stinkycobbler.dev/schemas/pack.schema.json" },
  role: { filename: "role-registry.schema.json", expectedId: "https://stinkycobbler.dev/schemas/role-registry.schema.json" },
  plugin: { filename: "plugin-manifest.schema.json", expectedId: "https://stinkycobbler.dev/schemas/plugin-manifest.schema.json" },
  "policy-decision": { filename: "policy-decision.schema.json", expectedId: "https://stinkycobbler.dev/schemas/policy-decision.schema.json" },
  "evidence-ref": { filename: "evidence-ref.schema.json", expectedId: "https://stinkycobbler.dev/schemas/evidence-ref.schema.json" },
  "agent-run": { filename: "agent-run.schema.json", expectedId: "https://stinkycobbler.dev/schemas/agent-run.schema.json" },
  "tool-call-record": { filename: "tool-call-record.schema.json", expectedId: "https://stinkycobbler.dev/schemas/tool-call-record.schema.json" },
  plan: { filename: "plan.schema.json", expectedId: "https://stinkycobbler.dev/schemas/plan.schema.json" },
  "write-intent": { filename: "write-intent.schema.json", expectedId: "https://stinkycobbler.dev/schemas/write-intent.schema.json" },
  "orchestration-contract": { filename: "orchestration-contract.schema.json", expectedId: "https://stinkycobbler.dev/schemas/orchestration-contract.schema.json" },
  "orchestration-subtask": { filename: "orchestration-subtask.schema.json", expectedId: "https://stinkycobbler.dev/schemas/orchestration-subtask.schema.json" },
  "orchestration-artifact": { filename: "orchestration-artifact.schema.json", expectedId: "https://stinkycobbler.dev/schemas/orchestration-artifact.schema.json" },
  "orchestration-review": { filename: "orchestration-review.schema.json", expectedId: "https://stinkycobbler.dev/schemas/orchestration-review.schema.json" },
  "orchestration-run": { filename: "orchestration-run.schema.json", expectedId: "https://stinkycobbler.dev/schemas/orchestration-run.schema.json" },
  "orchestration-validator-receipt": { filename: "orchestration-validator-receipt.schema.json", expectedId: "https://stinkycobbler.dev/schemas/orchestration-validator-receipt.schema.json" },
  "orchestration-transaction": { filename: "orchestration-transaction.schema.json", expectedId: "https://stinkycobbler.dev/schemas/orchestration-transaction.schema.json" },
  "orchestration-policy": { filename: "orchestration-policy.schema.json", expectedId: "https://stinkycobbler.dev/schemas/orchestration-policy.schema.json" },
  "specialists-policy": { filename: "specialists-policy.schema.json", expectedId: "https://stinkycobbler.dev/schemas/specialists-policy.schema.json" },
  "templates-policy": { filename: "templates-policy.schema.json", expectedId: "https://stinkycobbler.dev/schemas/templates-policy.schema.json" },
  "contract-templates-policy": { filename: "contract-templates-policy.schema.json", expectedId: "https://stinkycobbler.dev/schemas/contract-templates-policy.schema.json" },
  "cancellation-fence": { filename: "cancellation-fence.schema.json", expectedId: "https://stinkycobbler.dev/schemas/cancellation-fence.schema.json" },
  "lease-usage": { filename: "lease-usage.schema.json", expectedId: "https://stinkycobbler.dev/schemas/lease-usage.schema.json" },
  "audit-outbox": { filename: "audit-outbox.schema.json", expectedId: "https://stinkycobbler.dev/schemas/audit-outbox.schema.json" },
  "docs-index": { filename: "docs-index.schema.json", expectedId: "https://stinkycobbler.dev/schemas/docs-index.schema.json" },
  "role-tools-policy": { filename: "role-tools-policy.schema.json", expectedId: "https://stinkycobbler.dev/schemas/role-tools-policy.schema.json" },
  "plugin-registry-policy": { filename: "plugin-registry-policy.schema.json", expectedId: "https://stinkycobbler.dev/schemas/plugin-registry-policy.schema.json" }
};

export class SchemaRegistry {
  private readonly validators = new Map<ContractKind, ValidateFunction>();

  static async create(projectRoot: string): Promise<SchemaRegistry> {
    const registry = new SchemaRegistry();
    const require = createRequire(import.meta.url);
    const Ajv2020 = require("ajv/dist/2020.js").default as new (options: { allErrors: boolean; strict: boolean }) => { addSchema(schema: unknown): void; getSchema(id: string): ValidateFunction | undefined };
    const addFormats = require("ajv-formats").default as (instance: unknown) => void;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schemasDir = path.join(projectRoot, "schemas");
    const entries = await readdir(schemasDir);
    const parsedSchemas = new Map(await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map(async (entry) => {
      return [entry, JSON.parse(await readFile(path.join(schemasDir, entry), "utf8")) as unknown] as const;
    })));
    for (const { filename, expectedId } of Object.values(FILE_BY_KIND)) {
      const candidate = parsedSchemas.get(filename);
      const actualId = typeof candidate === "object" && candidate !== null && "$id" in candidate ? candidate.$id : undefined;
      if (actualId !== expectedId) {
        throw new Error(`Canonical schema ${filename} has unexpected $id (expected ${expectedId}, got ${String(actualId)}).`);
      }
    }
    for (const candidate of parsedSchemas.values()) ajv.addSchema(candidate);
    for (const [kind, { filename, expectedId }] of Object.entries(FILE_BY_KIND) as [ContractKind, CanonicalSchema][]) {
      const validator = ajv.getSchema(expectedId);
      if (!validator) throw new Error(`Schema was not registered: ${filename}`);
      registry.validators.set(kind, validator);
    }
    return registry;
  }

  validate(kind: ContractKind, value: unknown): void {
    const validator = this.validators.get(kind);
    if (!validator) throw new Error(`Unsupported contract kind: ${kind}`);
    if (!validator(value)) {
      throw new StinkyCobblerError("SCHEMA_INVALID", ExitCode.VALIDATION, `Invalid ${kind} contract.`, {
        kind,
        errors: formatErrors(validator.errors ?? [])
      });
    }
  }
}

function formatErrors(errors: ErrorObject[]): Array<{ path: string; message: string }> {
  return errors.map((error) => ({ path: error.instancePath || "/", message: error.message ?? error.keyword }));
}
