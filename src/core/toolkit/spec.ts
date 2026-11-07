import * as z from "zod";
import { ExitCode, StinkyCobblerError } from "../../errors.js";
import { HOST_IDS, TRANSPORTS } from "./kinds.js";

/** Whole value must be `${env:NAME}` or `${file:PATH}` with the plan's character class. */
const SECRET_REF_PATTERN = /^\$\{(env|file):[A-Z0-9_./-]+\}$/;

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const hostIdSchema = z.enum(HOST_IDS);
const sourceSchema = z.string().min(1);
const secretSchema = z.string().regex(SECRET_REF_PATTERN);

const skillSchema = z.strictObject({
  id: idSchema,
  source: sourceSchema,
  hosts: z.array(hostIdSchema).optional()
});

const mcpServerSchema = z.strictObject({
  id: idSchema,
  transport: z.enum(TRANSPORTS),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), secretSchema).optional(),
  role: z.literal("knowledge").optional(),
  sources: z.array(z.string().min(1)).optional()
});

const instructionsSchema = z.strictObject({
  id: idSchema,
  source: sourceSchema,
  kind: z.literal("memory").optional(),
  files: z.string().min(1).optional(),
  render: z.partialRecord(hostIdSchema, z.string().min(1)).optional()
});

const bundleSchema = z.strictObject({
  id: idSchema,
  includes: z.array(idSchema)
});

export const toolkitSpecSchema = z
  .strictObject({
    version: z.literal(1),
    hosts: z.array(hostIdSchema).optional(),
    scope: z.enum(["user", "project"]).optional(),
    skills: z.array(skillSchema).optional(),
    mcpServers: z.array(mcpServerSchema).optional(),
    instructions: z.array(instructionsSchema).optional(),
    bundles: z.array(bundleSchema).optional()
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const id of artifactIds(value)) {
      if (seen.has(id)) context.addIssue({ code: "custom", message: "TOOLKIT_DUPLICATE_ID", path: ["id"], input: id });
      seen.add(id);
    }
    rejectMemoryFiles(value.instructions ?? [], context);
  });

export type SkillSpec = z.infer<typeof skillSchema>;
export type McpServerSpec = z.infer<typeof mcpServerSchema>;
export type InstructionsSpec = z.infer<typeof instructionsSchema>;
type BundleSpec = z.infer<typeof bundleSchema>;
export interface ToolkitSpec {
  version: 1;
  hosts?: z.infer<typeof hostIdSchema>[];
  scope?: "user" | "project";
  skills: SkillSpec[];
  mcpServers: McpServerSpec[];
  instructions: InstructionsSpec[];
  bundles: BundleSpec[];
}

export function parseToolkitSpec(input: unknown): ToolkitSpec {
  const parsed = toolkitSpecSchema.safeParse(input);
  if (!parsed.success) throw specFailure(parsed.error);
  return {
    version: parsed.data.version,
    ...(parsed.data.hosts === undefined ? {} : { hosts: parsed.data.hosts }),
    ...(parsed.data.scope === undefined ? {} : { scope: parsed.data.scope }),
    skills: parsed.data.skills ?? [],
    mcpServers: parsed.data.mcpServers ?? [],
    instructions: parsed.data.instructions ?? [],
    bundles: parsed.data.bundles ?? []
  };
}

export function toolkitJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(toolkitSpecSchema) as Record<string, unknown>;
  return { ...generated, $id: "https://stinkycobbler.dev/schemas/toolkit.schema.json" };
}

function rejectMemoryFiles(items: readonly { id: string; kind?: "memory" | undefined; files?: string | undefined }[], context: z.RefinementCtx): void {
  for (const item of items) {
    if (item.files === undefined) continue;
    const remote = item.files.startsWith("git+") || item.files.startsWith("npm:") || item.files.startsWith("skills.sh:");
    if (item.kind === "memory" && !remote) continue;
    context.addIssue({ code: "custom", message: "TOOLKIT_MEMORY_FILES", path: ["files"], input: item.id });
  }
}

function artifactIds(value: {
  skills?: { id: string }[] | undefined;
  mcpServers?: { id: string }[] | undefined;
  instructions?: { id: string }[] | undefined;
  bundles?: { id: string }[] | undefined;
}): string[] {
  return [...(value.skills ?? []), ...(value.mcpServers ?? []), ...(value.instructions ?? []), ...(value.bundles ?? [])].map((item) => item.id);
}

function specFailure(error: z.ZodError): StinkyCobblerError {
  const secret = error.issues.find((issue) => issue.path.includes("env"));
  if (secret) return specError("SECRET_LITERAL_FORBIDDEN", "Env values must be ${env:NAME} or ${file:PATH} references.", { path: secret.path });
  const host = error.issues.find((issue) => issue.path.includes("hosts") || issue.path.includes("render"));
  if (host) return specError("TOOLKIT_HOST_UNKNOWN", `host must be one of: ${HOST_IDS.join(", ")}.`, { path: host.path, allowed: [...HOST_IDS] });
  const duplicate = error.issues.find((issue) => issue.message === "TOOLKIT_DUPLICATE_ID");
  if (duplicate) return specError("TOOLKIT_DUPLICATE_ID", "Artifact ids must be unique.", { id: duplicate.input });
  const memoryFiles = error.issues.find((issue) => issue.message === "TOOLKIT_MEMORY_FILES");
  if (memoryFiles) return specError("TOOLKIT_MEMORY_FILES", "Memory files must be a local directory on a memory instruction.", { id: memoryFiles.input });
  return specError("TOOLKIT_SPEC_INVALID", "Toolkit spec is invalid.", { issues: error.issues.map((issue) => issue.message) });
}

function specError(code: string, message: string, details: Record<string, unknown>): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details);
}
