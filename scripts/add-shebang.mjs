import { readFile, writeFile } from "node:fs/promises";

for (const file of ["dist/cli.js", "dist/mcp-server.js"]) {
  const content = await readFile(file, "utf8");
  if (!content.startsWith("#!/usr/bin/env node\n")) await writeFile(file, `#!/usr/bin/env node\n${content}`, "utf8");
}
