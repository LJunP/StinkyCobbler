import { StinkyCobblerError, ExitCode } from "../../errors.js";
import type { InstructionsSpec, McpServerSpec, SkillSpec } from "../toolkit/spec.js";
import type { ToolkitHostId } from "../toolkit/kinds.js";

export interface RenderedMcpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function renderSkillDir(skill: SkillSpec, body: string): { files: Record<string, string> } {
  void skill;
  return { files: { "SKILL.md": body } };
}

export function renderMcpEntry(server: McpServerSpec): RenderedMcpEntry {
  return {
    command: server.command,
    args: [...(server.args ?? [])],
    ...(server.env === undefined ? {} : { env: { ...server.env } })
  };
}

export function renderInstructionSegment(instructions: InstructionsSpec, host: ToolkitHostId, body: string): string {
  if (instructions.render?.[host] === undefined) {
    throw new StinkyCobblerError("TOOLKIT_HOST_UNSUPPORTED", ExitCode.VALIDATION, `Instruction ${instructions.id} does not render to ${host}.`, {
      id: instructions.id,
      host
    });
  }
  const text = body.endsWith("\n") ? body : `${body}\n`;
  return `<!-- stinky-cobbler:begin ${instructions.id} -->\n${text}<!-- stinky-cobbler:end ${instructions.id} -->`;
}
