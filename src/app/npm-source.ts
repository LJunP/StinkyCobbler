import { execFile } from "node:child_process";
import { lstat, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { toolkitContentHash } from "../core/toolkit/lock.js";
import type { ToolkitSpec } from "../core/toolkit/spec.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";

const execFileAsync = promisify(execFile);
const REGISTRY_SPEC = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@.+$/i;

export async function fetchNpmSkills(spec: ToolkitSpec, root: string): Promise<Record<string, string>> {
  const fetched: Record<string, string> = {};
  for (const skill of spec.skills) {
    if (!skill.source.startsWith("npm:")) continue;
    fetched[skill.id] = await readNpmSkill(skill.source, path.join(root, toolkitContentHash(skill.source)));
  }
  return fetched;
}

async function readNpmSkill(source: string, directory: string): Promise<string> {
  const spec = source.slice("npm:".length);
  if (path.isAbsolute(spec)) return readPackageSkill(spec);
  if (!REGISTRY_SPEC.test(spec) || spec.includes("..")) throw npmError("TOOLKIT_NPM_SOURCE_INVALID", "npm source must be a package directory or name@version.");
  return readRegistrySkill(spec, directory);
}

async function readPackageSkill(directory: string): Promise<string> {
  await readFile(path.join(directory, "package.json"), "utf8");
  try {
    const skill = path.join(directory, "SKILL.md");
    if (!(await lstat(skill)).isFile()) throw npmError("TOOLKIT_NPM_SKILL_MISSING", "The npm package has no SKILL.md.");
    return await readFile(skill, "utf8");
  } catch (error: unknown) {
    if (error instanceof StinkyCobblerError) throw error;
    throw npmError("TOOLKIT_NPM_SKILL_MISSING", "The npm package has no SKILL.md.");
  }
}

async function readRegistrySkill(spec: string, directory: string): Promise<string> {
  const tarballUrl = await registryTarball(spec);
  if (!tarballUrl.startsWith("https://")) throw npmError("TOOLKIT_NPM_SOURCE_INVALID", "npm tarball URL must be https.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tarball = path.join(directory, "package.tgz");
  const response = await fetch(tarballUrl);
  if (!response.ok) throw npmError("TOOLKIT_NPM_FETCH_FAILED", `npm tarball download failed with status ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 5_000_000) throw npmError("TOOLKIT_NPM_FETCH_FAILED", "npm tarball is larger than 5 MB.");
  await writeFile(tarball, bytes, { mode: 0o600 });
  return tarSkill(tarball);
}

async function registryTarball(spec: string): Promise<string> {
  try {
    const result = await execFileAsync("npm", ["view", spec, "dist.tarball", "--json"], {
      env: npmEnv(),
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 1_000_000,
      shell: false,
      windowsHide: true
    });
    const url = JSON.parse(result.stdout) as unknown;
    if (typeof url !== "string") throw npmError("TOOLKIT_NPM_FETCH_FAILED", "npm did not return a tarball URL.");
    return url;
  } catch (error: unknown) {
    if (error instanceof StinkyCobblerError) throw error;
    throw npmError("TOOLKIT_NPM_FETCH_FAILED", error instanceof Error ? error.message.slice(0, 300) : "npm view failed.");
  }
}

async function tarSkill(tarball: string): Promise<string> {
  try {
    const result = await execFileAsync("tar", ["-xOf", tarball, "package/SKILL.md"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1_000_000,
      shell: false,
      windowsHide: true
    });
    return result.stdout;
  } catch {
    throw npmError("TOOLKIT_NPM_SKILL_MISSING", "The npm package has no SKILL.md.");
  }
}

function npmEnv(): NodeJS.ProcessEnv {
  return { ...process.env, npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false" };
}

function npmError(code: string, message: string): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.VALIDATION, message);
}
