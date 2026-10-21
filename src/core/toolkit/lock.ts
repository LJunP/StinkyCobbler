import { createHash } from "node:crypto";
import * as z from "zod";
import { ExitCode, StinkyCobblerError } from "../../errors.js";
import type { ToolkitSpec } from "./spec.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const lockEntrySchema = z.strictObject({
  kind: z.enum(["skill", "instructions"]),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  source: z.string().min(1),
  resolved: z.enum(["local", "not-fetched", "absent"]),
  sha256: sha256Schema.optional()
});

const toolkitLockSchema = z.strictObject({ version: z.literal(1), entries: z.array(lockEntrySchema) }).superRefine((value, context) => {
  const seen = new Set<string>();
  for (const entry of value.entries) {
    const key = `${entry.kind}\0${entry.id}`;
    if (seen.has(key)) context.addIssue({ code: "custom", message: "duplicate", path: ["id"], input: entry.id });
    seen.add(key);
    const hashed = entry.sha256 !== undefined;
    if ((entry.resolved === "local") !== hashed) context.addIssue({ code: "custom", message: "hash", path: ["sha256"], input: entry.id });
  }
});

export interface LockEntry {
  kind: "skill" | "instructions";
  id: string;
  source: string;
  resolved: "local" | "not-fetched" | "absent";
  sha256?: string;
}

export interface ToolkitLock {
  version: 1;
  entries: LockEntry[];
}

export interface LockBodies {
  skills: Readonly<Record<string, string | undefined>>;
  instructions: Readonly<Record<string, string | undefined>>;
}

export function isRemoteToolkitSource(source: string): boolean {
  return source.startsWith("git+") || source.startsWith("npm:") || source.startsWith("skills.sh:");
}

export function toolkitContentHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function buildToolkitLock(spec: ToolkitSpec, bodies: LockBodies): ToolkitLock {
  return {
    version: 1,
    entries: [
      ...spec.skills.map((skill) => lockEntry("skill", skill.id, skill.source, bodies.skills[skill.id])),
      ...spec.instructions.map((item) => lockEntry("instructions", item.id, item.source, bodies.instructions[item.id]))
    ]
  };
}

export function parseToolkitLock(input: unknown): ToolkitLock {
  const parsed = toolkitLockSchema.safeParse(input);
  if (!parsed.success) throw new StinkyCobblerError("TOOLKIT_LOCK_INVALID", ExitCode.VALIDATION, "Toolkit lock is invalid.");
  return { version: 1, entries: parsed.data.entries.map(cleanEntry) };
}

function lockEntry(kind: LockEntry["kind"], id: string, source: string, body: string | undefined): LockEntry {
  if (isRemoteToolkitSource(source)) return { kind, id, source, resolved: "not-fetched" };
  if (body === undefined) return { kind, id, source, resolved: "absent" };
  return { kind, id, source, resolved: "local", sha256: toolkitContentHash(body) };
}

function cleanEntry(entry: z.infer<typeof lockEntrySchema>): LockEntry {
  return {
    kind: entry.kind,
    id: entry.id,
    source: entry.source,
    resolved: entry.resolved,
    ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 })
  };
}
