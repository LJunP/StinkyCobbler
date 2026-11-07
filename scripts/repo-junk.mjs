const MIB = 1024 * 1024;
// Tags at the start of a line (after a comment opener or a markdown list marker) or after an inline comment opener.
// A tag inside a string literal or mid-sentence prose is not matched.
const LEADING_TAG = /^[ \t]*(?:\/\/|\/\*+|\*|<!--|#|[-+]|\d+[.)])?[ \t]*(TODO|FIXME|XXX)\b(.*)$/;
const INLINE_TAG = /(?:\/\/|\/\*+|<!--)\s*(TODO|FIXME|XXX)\b(.*)$/;
const OWNED_TODO = /^\([a-z0-9]+(?:-[a-z0-9]+)*\):/;
const CENTRAL = /\b(?:gateResourceRelative|gateResource|toolkitResource)\s*\(/;
/** Segment literals only count inside a path-building call; enum arrays and object keys may reuse the words. */
const PATH_CALL = /\b(?:join|resolve)\s*\(/;

/**
 * STANDARDS C14 and C11.
 * src/gate is frozen and already calls gateResource(), so its literals stay.
 * src/hosts may spell ".codex"/".zcode" and the host directory "skills".
 * src/io/tiered-config.ts names the user XDG policies directory, not resources/gate.
 * Segment arguments of gateResource, gateResourceRelative, and toolkitResource are the C11 API.
 */
export function checkJunk(entries) {
  const problems = [];
  for (const entry of entries) {
    const file = entry.path.replaceAll("\\", "/");
    if (entry.size > MIB) problems.push(`${file} is larger than 1 MiB`);
    if (typeof entry.text !== "string") continue;
    problems.push(...taskProblems(file, entry.text), ...consoleProblems(file, entry.text), ...resourceProblems(file, entry.text));
  }
  return problems;
}

function taskProblems(file, text) {
  if (!scansTasks(file)) return [];
  const problems = [];
  for (const line of text.split(/\n/)) {
    const match = LEADING_TAG.exec(line) ?? INLINE_TAG.exec(line);
    if (!match || (match[1] === "TODO" && OWNED_TODO.test(match[2]))) continue;
    problems.push(`${file}: ownerless ${match[1]}`);
  }
  return problems;
}

function scansTasks(file) {
  if (file.startsWith("docs/archive/")) return false;
  return file.startsWith("src/") || file.startsWith("test/") || file.startsWith("scripts/") || file.startsWith("docs/");
}

function consoleProblems(file, text) {
  if (!file.startsWith("src/") || consoleAllowed(file)) return [];
  const problems = [];
  for (const match of text.matchAll(/console\.(log|debug|info)\b/g)) {
    problems.push(`${file}: console.${match[1]} is outside the presenter`);
  }
  return problems;
}

function consoleAllowed(file) {
  return file === "src/cli.ts" || file === "src/mcp-server.ts" || file.startsWith("src/app/") || file.startsWith("src/gate/");
}

function resourceProblems(file, text) {
  if (!file.startsWith("src/") || file === "src/io/resources.ts" || file.startsWith("src/gate/")) return [];
  const problems = [];
  for (const line of text.split(/\n/)) problems.push(...resourceLine(file, line));
  return problems;
}

function resourceLine(file, line) {
  const problems = [];
  if (PATH_CALL.test(line)) {
    for (const match of line.matchAll(/"(resources|schemas|policies|profiles|packs|plugins|examples|skills)"\s*[,)]/g)) {
      if (!resourceExempt(file, line, "segment", match[1])) problems.push(`${file}: resource path literal ${JSON.stringify(match[1])}`);
    }
  }
  for (const match of line.matchAll(/"\.(codex|zcode)"\s*[,)]/g)) {
    const token = `.${match[1]}`;
    if (!resourceExempt(file, line, "host-dot", token)) problems.push(`${file}: resource path literal ${JSON.stringify(token)}`);
  }
  if (/"resources\//.test(line) && !resourceExempt(file, line, "prefix", "resources/")) {
    problems.push(`${file}: resource path literal "resources/"`);
  }
  return problems;
}

function resourceExempt(file, line, kind, token) {
  if (file.startsWith("src/hosts/") && kind === "host-dot") return true;
  if (file.startsWith("src/hosts/") && kind === "segment" && token === "skills") return true;
  if (file === "src/io/tiered-config.ts" && kind === "segment" && token === "policies") return true;
  return CENTRAL.test(line);
}
