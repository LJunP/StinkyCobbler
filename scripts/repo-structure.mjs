import { parse } from "yaml";

const SEGMENT = /^[a-z0-9][a-z0-9.-]*$/;
const ROOT_DOTFILE = /^\.[a-z0-9][a-z0-9.-]*$/;

/** Naming exceptions from STANDARDS §2. Tests pass a replacement object. */
export const DEFAULT_NAMING_EXEMPTIONS = {
  conventionalNames: [
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "LICENSE",
    "AGENTS.md",
    "PRD.md",
    "PLAN.md",
    "PROGRESS.md",
    "STANDARDS.md"
  ],
  githubPrefix: ".github/",
  skillFileName: "SKILL.md",
  skillPrefix: "resources/gate/skills/",
  allowRootDotfiles: true
};

/** Extract and parse the ```yaml repo-structure block. */
export function parseRepoStructure(markdown) {
  const match = /```yaml repo-structure\r?\n([\s\S]*?)```/.exec(markdown);
  if (!match) throw new Error("missing ```yaml repo-structure block");
  const structure = parse(match[1]);
  if (structure === null || typeof structure !== "object" || Array.isArray(structure)) {
    throw new Error("repo-structure block must be a YAML mapping");
  }
  return structure;
}

/** Root and managed-directory whitelist. Empty array means the tree is ok. */
export function checkStructure(trackedPaths, structure) {
  const problems = [];
  const rootDirs = new Set(structure.rootDirs);
  const rootFiles = new Set(structure.rootFiles);
  const ignored = new Set(structure.ignoredLocal);
  const seen = new Map();
  for (const file of trackedPaths.map(normalize)) {
    const [top, entry] = file.split("/");
    if (ignored.has(top)) problems.push(`tracked ignoredLocal path: ${file}`);
    if (entry === undefined) {
      if (!rootFiles.has(file)) problems.push(`root file not allowed: ${file}`);
      continue;
    }
    if (!rootDirs.has(top)) problems.push(`root directory not allowed: ${top}`);
    const entries = seen.get(top) ?? new Set();
    entries.add(entry);
    seen.set(top, entries);
  }
  for (const [dir, allowed] of Object.entries(structure.managed)) {
    for (const entry of seen.get(dir) ?? []) {
      if (!entryAllowed(allowed, entry)) problems.push(`managed entry not allowed: ${dir}/${entry}`);
    }
  }
  return problems;
}

/** Kebab-case path segments, with the exemptions supplied by the caller. */
export function checkNaming(trackedPaths, exemptions = DEFAULT_NAMING_EXEMPTIONS) {
  const problems = [];
  for (const file of trackedPaths.map(normalize)) {
    if (underGithub(file, exemptions)) continue;
    for (const [index, segment] of file.split("/").entries()) {
      if (segmentAllowed(file, index, segment, exemptions)) continue;
      problems.push(`${file} has a non-kebab-case segment "${segment}"`);
    }
  }
  return problems;
}

/** Every ignoredLocal name must be covered by an exact, name/, or /name/ gitignore line. */
export function checkIgnored(gitignoreText, ignoredLocal) {
  const lines = gitignoreText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  const problems = [];
  for (const name of ignoredLocal) {
    const covered = lines.some((line) => line === name || line === `${name}/` || line === `/${name}/`);
    if (!covered) problems.push(`ignoredLocal entry "${name}" is not covered by .gitignore`);
  }
  return problems;
}

function entryAllowed(allowed, entry) {
  return allowed.some((rule) => rule.startsWith("*.") ? entry.endsWith(rule.slice(1)) : rule === entry);
}

function segmentAllowed(file, index, segment, exemptions) {
  if (exemptions.conventionalNames.includes(segment)) return true;
  if (segment === exemptions.skillFileName && file.startsWith(exemptions.skillPrefix)) return true;
  if (exemptions.allowRootDotfiles !== false && index === 0 && ROOT_DOTFILE.test(segment)) return true;
  return SEGMENT.test(segment);
}

function underGithub(file, exemptions) {
  const prefix = exemptions.githubPrefix;
  if (!prefix) return false;
  const root = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return file === root || file.startsWith(`${root}/`);
}

function normalize(filePath) {
  return filePath.replaceAll("\\", "/");
}
