import type { Command } from "commander";
import { applyToolkit, doctorToolkit, initToolkit, listToolkit, planToolkit, rollbackToolkit } from "./toolkit-flow.js";

interface ToolkitOptions {
  json?: boolean;
  scope?: string;
  yes?: boolean;
  last?: boolean;
  to?: string;
}

export function registerToolkitCommands(program: Command): void {
  const toolkit = program.command("toolkit").description("Plan and apply a declarative agent toolkit.");
  bind(toolkit, "init", ["--scope <scope>"], (options) => initToolkit(options.scope));
  bind(toolkit, "plan", ["--scope <scope>"], (options) => planToolkit(options.scope));
  bind(toolkit, "apply", ["--scope <scope>", "--yes"], (options) => applyToolkit({ scope: options.scope, yes: options.yes }));
  bind(toolkit, "rollback", ["--last", "--to <applyId>"], (options) => rollbackToolkit({ last: options.last, to: options.to }));
  bind(toolkit, "doctor", ["--scope <scope>"], (options) => doctorToolkit(options.scope));
  bind(toolkit, "list", ["--scope <scope>"], (options) => listToolkit(options.scope));
}

function bind(toolkit: Command, name: string, flags: readonly string[], run: (options: ToolkitOptions) => Promise<unknown>): void {
  const command = toolkit.command(name).option("--json");
  for (const flag of flags) command.option(flag);
  command.action(async (options: ToolkitOptions) => emit(await run(options), options.json));
}

function emit(value: unknown, json?: boolean): void {
  console.log(json === true ? JSON.stringify(value) : JSON.stringify(value, null, 2));
}
