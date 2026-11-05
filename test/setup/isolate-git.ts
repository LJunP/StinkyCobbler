import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Env vars that relocate which repository a git process uses. */
export const GIT_REPOSITORY_OVERRIDE_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS"
] as const;

const OVERRIDE_NAMES = new Set(GIT_REPOSITORY_OVERRIDE_VARS.map((key) => key.toUpperCase()));
const CONFIG_PAIR = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

function isRepositoryOverride(name: string): boolean {
  const upper = name.toUpperCase();
  return OVERRIDE_NAMES.has(upper) || CONFIG_PAIR.test(upper);
}

/** Empty file that replaces ~/.gitconfig and the system gitconfig. */
function emptyGitConfigFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "stinky-git-config-"));
  const file = path.join(dir, "empty");
  writeFileSync(file, "");
  return file;
}

/**
 * Strip repository-locating git env and pin identity files to an empty config.
 * Husky pre-push in a linked worktree sets GIT_DIR to an absolute path, which
 * overrides `git -C <fixture>` and writes the real repository.
 */
export function isolateGitEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (isRepositoryOverride(key)) delete env[key];
  }
  const empty = emptyGitConfigFile();
  env.GIT_CONFIG_GLOBAL = empty;
  env.GIT_CONFIG_SYSTEM = empty;
}

isolateGitEnv(process.env);
