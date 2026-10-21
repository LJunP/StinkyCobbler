import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { resolveConfigHome } from "./tiered-config.js";

export interface ToolkitLedgerEvent {
  event: "toolkit-op-applied";
  applyId: string;
  index: number;
  action: string;
  host: string;
  kind: string;
  id: string;
  path: string;
  beforeHash: string | null;
  afterHash: string;
}

export function toolkitLedgerPath(env: Readonly<NodeJS.ProcessEnv> = process.env, homeDirectory = homedir()): string {
  return path.join(resolveConfigHome(env, homeDirectory), "stinky-cobbler", "ledger.jsonl");
}

export async function appendToolkitEvent(event: ToolkitLedgerEvent, file = toolkitLedgerPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readToolkitEvents(file = toolkitLedgerPath()): Promise<ToolkitLedgerEvent[]> {
  try {
    const text = await readFile(file, "utf8");
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ToolkitLedgerEvent);
  } catch (error: unknown) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
