import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOSTS = {
  codex: "resources/gate/skills/codex/SKILL.md",
  zcode: "resources/gate/skills/zcode/SKILL.md"
};

function toLf(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function parseSlots(text) {
  const source = toLf(text);
  const body = source.endsWith("\n") ? source.slice(0, -1) : source;
  const slots = {};
  let key = null;
  let lines = [];
  const flush = () => {
    if (key !== null) slots[key] = lines.join("\n");
  };
  for (const line of body.split(/\r?\n/)) {
    const mark = /^@@([A-Za-z0-9_]+)@@$/.exec(line);
    if (mark) {
      flush();
      key = mark[1];
      lines = [];
    } else if (key !== null) lines.push(line);
  }
  flush();
  return slots;
}

export function renderSkill(core, slots) {
  const used = new Set();
  const missing = [];
  const rendered = toLf(core).replace(/@@([A-Za-z0-9_]+)@@/g, (token, key) => {
    if (!Object.hasOwn(slots, key)) {
      missing.push(key);
      return token;
    }
    used.add(key);
    return slots[key];
  });
  const unused = Object.keys(slots).filter((key) => !used.has(key));
  if (missing.length > 0 || unused.length > 0 || rendered.includes("@@")) {
    throw new Error(`Skill slots missing=${missing.join(",") || "-"} unused=${unused.join(",") || "-"}`);
  }
  const lf = toLf(rendered);
  return lf.endsWith("\n") ? lf : `${lf}\n`;
}

async function main() {
  const check = process.argv.includes("--check");
  const core = await readFile(path.join(root, "resources/gate/skills/templates/skill-core.md"), "utf8");
  const drifted = [];
  for (const [host, relative] of Object.entries(HOSTS)) {
    const slots = parseSlots(await readFile(path.join(root, "resources/gate/skills/templates/hosts", `${host}.md`), "utf8"));
    const rendered = renderSkill(core, slots);
    const target = path.join(root, relative);
    const current = toLf(await readFile(target, "utf8"));
    if (current !== rendered) {
      drifted.push(relative);
      if (!check) await writeFile(target, rendered);
    }
  }
  if (check && drifted.length > 0) {
    console.error(`Skill render drift: ${drifted.join(", ")}`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await main();
