import { type ErrorObject, type ValidateFunction } from "ajv";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { StinkyCobblerError, ExitCode } from "../errors.js";

export type ContractKind = "task" | "artifact" | "capsule" | "lease" | "receipt" | "approval" | "audit" | "config" | "profile" | "pack" | "role" | "plugin" | "policy-decision" | "evidence-ref" | "agent-run" | "tool-call-record" | "plan" | "orchestration-contract" | "orchestration-subtask" | "orchestration-artifact" | "orchestration-review" | "orchestration-run";

const FILE_BY_KIND: Record<ContractKind, string> = {
  task: "task.schema.json",
  artifact: "artifact.schema.json",
  capsule: "task-capsule.schema.json",
  lease: "capability-lease.schema.json",
  receipt: "agent-receipt.schema.json",
  approval: "approval.schema.json",
  audit: "audit-event.schema.json",
  config: "workspace-config.schema.json",
  profile: "profile.schema.json",
  pack: "pack.schema.json",
  role: "role-registry.schema.json",
  plugin: "plugin-manifest.schema.json",
  "policy-decision": "policy-decision.schema.json",
  "evidence-ref": "evidence-ref.schema.json",
  "agent-run": "agent-run.schema.json",
  "tool-call-record": "tool-call-record.schema.json",
  plan: "plan.schema.json",
  "orchestration-contract": "orchestration-contract.schema.json",
  "orchestration-subtask": "orchestration-subtask.schema.json",
  "orchestration-artifact": "orchestration-artifact.schema.json",
  "orchestration-review": "orchestration-review.schema.json",
  "orchestration-run": "orchestration-run.schema.json"
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
    await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map(async (entry) => {
      ajv.addSchema(JSON.parse(await readFile(path.join(schemasDir, entry), "utf8")));
    }));
    for (const [kind, filename] of Object.entries(FILE_BY_KIND) as [ContractKind, string][]) {
      const schema = JSON.parse(await readFile(path.join(schemasDir, filename), "utf8"));
      const validator = ajv.getSchema(schema.$id);
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
