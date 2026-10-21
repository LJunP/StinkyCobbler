import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { toolkitContentHash } from "../core/toolkit/lock.js";
import type { ToolkitSpec } from "../core/toolkit/spec.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";

const execFileAsync = promisify(execFile);
const DISABLED = "/dev/null";

interface GitSource {
  url: string;
  subdir: string;
  protocol: "file:" | "https:";
}

export async function fetchGitSkills(spec: ToolkitSpec, root: string): Promise<Record<string, string>> {
  const fetched: Record<string, string> = {};
  for (const skill of spec.skills) {
    if (!skill.source.startsWith("git+")) continue;
    fetched[skill.id] = await readGitSkill(skill.source, path.join(root, toolkitContentHash(skill.source)));
  }
  return fetched;
}

export async function readGitSkill(source: string, directory: string): Promise<string> {
  const parsed = parseGitSource(source);
  const template = path.join(path.dirname(directory), ".template");
  await rm(directory, { recursive: true, force: true });
  await mkdir(template, { recursive: true, mode: 0o700 });
  await runGit(parsed.protocol, ["clone", "--bare", "--depth", "1", parsed.url, directory], template, "TOOLKIT_GIT_FETCH_FAILED");
  const object = parsed.subdir.length === 0 ? "HEAD:SKILL.md" : `HEAD:${parsed.subdir}/SKILL.md`;
  return runGit(parsed.protocol, ["--git-dir", directory, "cat-file", "blob", object], template, "TOOLKIT_GIT_SKILL_MISSING");
}

export function parseGitSource(source: string): GitSource {
  const rest = source.slice("git+".length);
  const mark = rest.indexOf("#");
  const urlText = mark === -1 ? rest : rest.slice(0, mark);
  const subdir = mark === -1 ? "" : rest.slice(mark + 1);
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw gitError("TOOLKIT_GIT_SOURCE_INVALID", "git+ source must be a file or https URL.");
  }
  if (url.protocol !== "file:" && url.protocol !== "https:") throw gitError("TOOLKIT_GIT_SOURCE_INVALID", "git+ source must use file or https.");
  if (url.username.length > 0 || url.password.length > 0) throw gitError("TOOLKIT_GIT_SOURCE_INVALID", "git+ source must not include credentials.");
  if (subdir.length > 0 && subdir.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw gitError("TOOLKIT_GIT_SOURCE_INVALID", "git+ subdirectory must stay inside the repository.");
  }
  return { url: urlText, subdir, protocol: url.protocol };
}

async function runGit(protocol: GitSource["protocol"], args: readonly string[], template: string, code: string): Promise<string> {
  const allow = protocol === "file:" ? "protocol.file.allow=always" : "protocol.https.allow=always";
  try {
    const result = await execFileAsync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", `core.attributesFile=${DISABLED}`, "-c", allow, ...args],
      {
        env: gitEnv(template),
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 1_000_000,
        shell: false,
        windowsHide: true
      }
    );
    return result.stdout;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "git failed";
    throw gitError(code, detail.slice(0, 300));
  }
}

function gitEnv(template: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = DISABLED;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_TEMPLATE_DIR = template;
  return env;
}

function gitError(code: string, message: string): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.VALIDATION, message);
}
