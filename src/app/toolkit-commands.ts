import type { Command } from "commander";
import { editToolkitMemory, showToolkitMemory } from "./memory-segment.js";
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
  bind(toolkit, "apply", ["--scope <scope>", "--yes"], (options) => applyToolkit({ scope: options.scope, yes: options.yes }));
  bind(toolkit, "rollback", ["--last", "--to <applyId>"], (options) => rollbackToolkit({ last: options.last, to: options.to }));
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

function bind(toolkit: Command, name: string, flags: readonly string[], run: (options: ToolkitOptions) => Promise<unknown>): void {
  const command = toolkit.command(name).option("--json");
  for (const flag of flags) command.option(flag);
  command.action(async (options: ToolkitOptions) => emit(await run(options), options.json));
}

function emit(value: unknown, json?: boolean): void {
  console.log(json === true ? JSON.stringify(value) : JSON.stringify(value, null, 2));
}
