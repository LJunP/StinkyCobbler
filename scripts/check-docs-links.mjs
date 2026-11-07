import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectInvocation } from "./release-utils.mjs";

const LINK = /!?\[[^\]\n]*\]\(([^)\n]*)\)/g;

/** Relative markdown links, skipping fenced code, HTML comments and inline code. A trailing "title" is removed. */
export function collectLinks(markdown) {
  const visible = maskInline(maskComments(maskFences(markdown)));
  const links = [];
  LINK.lastIndex = 0;
  for (const match of visible.matchAll(LINK)) {
    const target = stripTitle(match[1]);
    if (target !== "" && isRelativeLink(target)) links.push(target);
  }
  return links;
}

/** GitHub heading slugs. Duplicates are suffixed -1, -2, … */
export function slugsOf(markdown) {
  const counts = new Map();
  const slugs = [];
  for (const text of headingTexts(markdown)) {
    const base = slugify(text);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    slugs.push(seen === 0 ? base : `${base}-${seen}`);
  }
  return slugs;
}

/** Resolve each relative link against root. Problems are "file -> target (missing file|missing anchor)". */
export function checkLinks(root, files) {
  const problems = [];
  for (const file of files) {
    const markdown = readFileSync(path.join(root, file), "utf8");
    for (const target of collectLinks(markdown)) {
      const problem = linkProblem(root, file, markdown, target);
      if (problem) problems.push(problem);
    }
  }
  return problems;
}

function linkProblem(root, file, markdown, target) {
  const hash = target.indexOf("#");
  const pathPart = hash < 0 ? target : target.slice(0, hash);
  const anchor = hash < 0 ? "" : decodeAnchor(target.slice(hash + 1));
  if (pathPart === "") return missingAnchor(file, target, anchor, slugsOf(markdown));
  const absolute = resolveLink(root, file, pathPart);
  if (!existsSync(absolute)) return `${file} -> ${target} (missing file)`;
  if (anchor === "") return "";
  const slugs = absolute.endsWith(".md") ? slugsOf(readFileSync(absolute, "utf8")) : [];
  return missingAnchor(file, target, anchor, slugs);
}

function missingAnchor(file, target, anchor, slugs) {
  if (anchor === "" || slugs.includes(anchor)) return "";
  return `${file} -> ${target} (missing anchor)`;
}

/** A leading "/" is repository-root relative, as GitHub renders it. */
function resolveLink(root, file, pathPart) {
  const decoded = decodePath(pathPart);
  if (decoded.startsWith("/")) return path.resolve(root, `.${decoded}`);
  return path.resolve(root, path.dirname(file), decoded);
}

function decodePath(pathPart) {
  try {
    return decodeURIComponent(pathPart);
  } catch {
    return pathPart;
  }
}

function decodeAnchor(raw) {
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function headingTexts(markdown) {
  const lines = maskFences(markdown).split("\n");
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const atx = /^ {0,3}#{1,6}[ \t]+(.*)$/.exec(lines[index]);
    if (atx) {
      headings.push(cleanHeading(atx[1]));
      continue;
    }
    const setext = setextText(lines, index);
    if (setext !== null) headings.push(setext);
  }
  return headings;
}

function setextText(lines, index) {
  if (index === 0) return null;
  const underline = lines[index];
  if (!/^ {0,3}(?:=+|-+)[ \t]*$/.test(underline)) return null;
  const text = lines[index - 1];
  if (text.trim() === "" || /^ {0,3}#{1,6}[ \t]/.test(text)) return null;
  const before = index >= 2 ? lines[index - 2] : "";
  if (before.trim() !== "") return null;
  return cleanHeading(text);
}

function cleanHeading(raw) {
  return raw.replace(/[ \t]+#+\s*$/, "").replace(/`/g, "").trim();
}

function slugify(text) {
  let kept = "";
  for (const char of text.toLowerCase()) {
    if (char === " " || char === "-" || char === "_" || /[\p{L}\p{N}]/u.test(char)) kept += char;
  }
  return kept.trim().replace(/ +/g, "-");
}

function maskFences(markdown) {
  let fence = null;
  return markdown.split(/\r?\n/).map((line) => {
    const marker = fenceMarker(line);
    if (!marker) return fence ? "" : line;
    if (!fence) {
      fence = marker;
      return "";
    }
    if (marker.char === fence.char && marker.size >= fence.size && /^\s*(?:`{3,}|~{3,})[ \t]*$/.test(line)) fence = null;
    return "";
  }).join("\n");
}

/** Any indentation counts: fences inside list items are indented by four or more spaces. */
function fenceMarker(line) {
  const match = /^\s*(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  return { char: match[1][0], size: match[1].length };
}

function maskComments(markdown) {
  return markdown.replace(/<!--[\s\S]*?-->/g, (chunk) => chunk.replace(/[^\n]/g, " "));
}

function maskInline(markdown) {
  return markdown.replace(/``[^`\n]*``|`[^`\n]*`/g, (chunk) => " ".repeat(chunk.length));
}

function stripTitle(raw) {
  let value = raw.trim();
  if (value.startsWith("<")) {
    const end = value.indexOf(">");
    if (end > 0) value = value.slice(1, end).trim();
  }
  return value.replace(/\s+"[^"]*"\s*$/, "").replace(/\s+'[^']*'\s*$/, "").trim();
}

function isRelativeLink(target) {
  if (target.startsWith("#")) return true;
  if (target.startsWith("//")) return false;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target);
}

function trackedDocs(root) {
  const output = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "-z"], { cwd: root, encoding: "utf8" });
  return output.split("\0").filter((file) => file.endsWith(".md") || file.endsWith(".yml"));
}

if (isDirectInvocation(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkLinks(root, trackedDocs(root));
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
}
