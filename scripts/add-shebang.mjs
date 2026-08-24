import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function addShebangs(outputDirectory = "dist") {
  for (const name of ["cli.js", "mcp-server.js"]) {
    const file = path.join(outputDirectory, name);
    const content = await readFile(file, "utf8");
    if (!content.startsWith("#!/usr/bin/env node\n")) await writeFile(file, `#!/usr/bin/env node\n${content}`, "utf8");
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await addShebangs(process.argv[2] ?? "dist");
}
