import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { ZodError } from "zod";
import { registerCommands } from "./app/register-commands.js";
import { ExitCode, StinkyCobblerError } from "./errors.js";
import { STINKY_COBBLER_VERSION } from "./version.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const program = new Command();
program.name("stinky-cobbler").description("Declarative AI agent toolkit package manager: plan, apply, and rollback skills, MCP servers, and instructions across Codex, Claude Code, Cursor, and ZCode.").version(STINKY_COBBLER_VERSION);
registerCommands(program, projectRoot);
program.parseAsync().catch((error: unknown) => {
  if (error instanceof ZodError) {
    console.error(JSON.stringify({ error: "INPUT_INVALID", message: "A numeric option must be a nonnegative integer." }));
    process.exitCode = ExitCode.VALIDATION;
    return;
  }
  const result = error instanceof StinkyCobblerError
    ? { error: error.code, message: error.message, fix: "fix" in error.details ? error.details.fix : undefined, details: error.details }
    : { error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
  console.error(JSON.stringify(result));
  process.exitCode = error instanceof StinkyCobblerError ? error.exitCode : ExitCode.INTERNAL;
});
