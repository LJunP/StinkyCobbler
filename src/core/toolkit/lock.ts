import { createHash } from "node:crypto";
import * as z from "zod";
import { ExitCode, StinkyCobblerError } from "../../errors.js";
import type { ToolkitSpec } from "./spec.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const lockEntrySchema = z.strictObject({
  kind: z.enum(["skill", "instructions"]),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  source: z.string().min(1),
  resolved: z.enum(["local", "fetched", "not-fetched", "absent"]),
  sha256: sha256Schema.optional(),
  files: z.array(z.strictObject({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}\.md$/), sha256: sha256Schema })).optional()
});

const toolkitLockSchema = z.strictObject({ version: z.literal(1), entries: z.array(lockEntrySchema) }).superRefine((value, context) => {
  const seen = new Set<string>();
  for (const entry of value.entries) {
    const key = `${entry.kind}\0${entry.id}`;
    if (seen.has(key)) context.addIssue({ code: "custom", message: "duplicate", path: ["id"], input: entry.id });
    seen.add(key);
    const hashed = entry.sha256 !== undefined;
    const storesBytes = entry.resolved === "local" || entry.resolved === "fetched";
    if (storesBytes !== hashed) context.addIssue({ code: "custom", message: "hash", path: ["sha256"], input: entry.id });
  }
});

export interface LockEntry {
  kind: "skill" | "instructions";
  id: string;
  source: string;
  resolved: "local" | "fetched" | "not-fetched" | "absent";
  sha256?: string;
  files?: { name: string; sha256: string }[];
}

export interface ToolkitLock {
  version: 1;
  entries: LockEntry[];
}

export interface LockBodies {
  skills: Readonly<Record<string, string | undefined>>;
  instructions: Readonly<Record<string, string | undefined>>;
  fetchedSkills?: Readonly<Record<string, string>>;
  fetchedInstructions?: Readonly<Record<string, string>>;
  memoryFiles?: Readonly<Record<string, Readonly<Record<string, string>>>>;
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
      ...spec.skills.map((skill) => lockEntry("skill", skill.id, skill.source, bodies.skills[skill.id], bodies.fetchedSkills?.[skill.id])),
      ...spec.instructions.map((item) =>
        withMemoryFiles(
          lockEntry("instructions", item.id, item.source, bodies.instructions[item.id], bodies.fetchedInstructions?.[item.id]),
          bodies.memoryFiles?.[item.id]
        )
      )
    ]
  };
}

export function parseToolkitLock(input: unknown): ToolkitLock {
  const parsed = toolkitLockSchema.safeParse(input);
  if (!parsed.success) throw new StinkyCobblerError("TOOLKIT_LOCK_INVALID", ExitCode.VALIDATION, "Toolkit lock is invalid.");
  return { version: 1, entries: parsed.data.entries.map(cleanEntry) };
}

function lockEntry(kind: LockEntry["kind"], id: string, source: string, body: string | undefined, fetched: string | undefined): LockEntry {
  if (source.startsWith("git+") || source.startsWith("npm:")) {
    if (fetched === undefined) return { kind, id, source, resolved: "not-fetched" };
    return { kind, id, source, resolved: "fetched", sha256: toolkitContentHash(fetched) };
  }
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
    ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
    ...(entry.files === undefined ? {} : { files: entry.files.map((file) => ({ name: file.name, sha256: file.sha256 })) })
  };
}

function withMemoryFiles(entry: LockEntry, files: Readonly<Record<string, string>> | undefined): LockEntry {
  if (files === undefined) return entry;
  const listed = Object.keys(files)
    .sort()
    .map((name) => ({ name, sha256: toolkitContentHash(files[name] ?? "") }));
  if (listed.length === 0) return entry;
  return { ...entry, files: listed };
}
