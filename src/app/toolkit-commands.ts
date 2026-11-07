import process from "node:process";
import type { Command } from "commander";
import { ExitCode } from "../errors.js";
import type { ApplyReport } from "./apply.js";
import { editToolkitMemory, showToolkitMemory } from "./memory-segment.js";
import type { RollbackReport } from "./rollback.js";
import {
  applyToolkit,
  doctorToolkit,
  initToolkit,
  listToolkit,
  lockToolkit,
  planToolkit,
  rollbackToolkit,
  searchToolkit,
  updateToolkit
} from "./toolkit-flow.js";

interface ToolkitOptions {
  json?: boolean;
  scope?: string;
  yes?: boolean;
  last?: boolean;
  to?: string;
  host?: string;
  file?: string;
}

export function registerToolkitCommands(program: Command): void {
  const toolkit = program.command("toolkit").description("Plan and apply a declarative agent toolkit.");
  bind(toolkit, "init", ["--scope <scope>"], (options) => initToolkit(options.scope));
  bind(toolkit, "plan", ["--scope <scope>"], (options) => planToolkit(options.scope));
  bind(toolkit, "apply", ["--scope <scope>", "--yes"], (options) => applyToolkit({ scope: options.scope, yes: options.yes }), applyExitCode);
  bind(toolkit, "rollback", ["--last", "--to <applyId>"], (options) => rollbackToolkit({ last: options.last, to: options.to }), rollbackExitCode);
  bind(toolkit, "doctor", ["--scope <scope>"], (options) => doctorToolkit(options.scope));
  bind(toolkit, "list", ["--scope <scope>"], (options) => listToolkit(options.scope));
  bind(toolkit, "lock", ["--scope <scope>"], (options) => lockToolkit(options.scope));
  bind(toolkit, "update", ["--scope <scope>"], (options) => updateToolkit(options.scope));
  registerSearch(toolkit);
  registerMemory(toolkit);
}

function registerMemory(toolkit: Command): void {
  const memory = toolkit.command("memory").description("Show or replace one managed memory segment.");
  bindMemory(memory, "show", (id, options) => showToolkitMemory({ id, host: options.host, scope: options.scope }));
  bindMemory(memory, "edit", (id, options) => editToolkitMemory({ id, host: options.host, scope: options.scope, file: options.file }));
}

function bindMemory(memory: Command, name: string, run: (id: string, options: ToolkitOptions) => Promise<unknown>): void {
  memory
    .command(name)
    .argument("<id>")
    .option("--host <host>")
    .option("--scope <scope>")
    .option("--file <file>")
    .option("--json")
    .action(async (id: string, options: ToolkitOptions) => emit(await run(id, options), options.json));
}

function registerSearch(toolkit: Command): void {
  toolkit
    .command("search")
    .argument("<query>")
    .option("--json")
    .action(async (query: string) => {
      await searchToolkit(query);
    });
}

function bind<T>(
  toolkit: Command,
  name: string,
  flags: readonly string[],
  run: (options: ToolkitOptions) => Promise<T>,
  exitCode: (value: T) => number = () => ExitCode.OK
): void {
  const command = toolkit.command(name).option("--json");
  for (const flag of flags) command.option(flag);
  command.action(async (options: ToolkitOptions) => {
    const value = await run(options);
    emit(value, options.json);
    const code = exitCode(value);
    if (code !== ExitCode.OK) process.exitCode = code;
  });
}

/** STANDARDS C7: a stopped apply left the hosts half-written, so the process must not exit 0. The JSON report keeps the op's error code and the rollback hint. */
function applyExitCode(report: ApplyReport): number {
  return report.stopped ? ExitCode.INTERNAL : ExitCode.OK;
}

/** STANDARDS C7: a rollback that refused a user-edited file is a conflict result. */
function rollbackExitCode(report: RollbackReport): number {
  return report.conflict === undefined ? ExitCode.OK : ExitCode.CONFLICT;
}

function emit(value: unknown, json?: boolean): void {
  console.log(json === true ? JSON.stringify(value) : JSON.stringify(value, null, 2));
}
