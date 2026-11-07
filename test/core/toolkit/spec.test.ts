import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ARTIFACT_KINDS as adapterKinds } from "../../../src/hosts/host-adapter.js";
import { hostIds } from "../../../src/hosts/registry.js";
import { ARTIFACT_KINDS, HOST_IDS } from "../../../src/core/toolkit/kinds.js";
import { parseToolkitSpec, toolkitJsonSchema } from "../../../src/core/toolkit/spec.js";

describe("toolkit spec", () => {
  it("rejects a plaintext env value and names SECRET_LITERAL_FORBIDDEN", () => {
    expect(() => parseToolkitSpec({
      version: 1,
      mcpServers: [{ id: "filesystem", transport: "stdio", command: "npx", env: { TOKEN: "sk-abc" } }]
    })).toThrowError(expect.objectContaining({ code: "SECRET_LITERAL_FORBIDDEN" }));
  });

  it("rejects a duplicate id", () => {
    expect(() => parseToolkitSpec({
      version: 1,
      skills: [
        { id: "same", source: "./a" },
        { id: "same", source: "./b" }
      ]
    })).toThrowError(expect.objectContaining({ code: "TOOLKIT_DUPLICATE_ID" }));
  });

  it("rejects an unknown host and lists the legal hosts", () => {
    try {
      parseToolkitSpec({ version: 1, hosts: ["gemini"] });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "TOOLKIT_HOST_UNKNOWN" });
      for (const id of hostIds()) expect((error as Error).message).toContain(id);
    }
  });

  it("accepts an env reference and keeps host ids aligned with the adapters", () => {
    const parsed = parseToolkitSpec({
      version: 1,
      scope: "user",
      mcpServers: [{
        id: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
        env: { API_TOKEN: "${env:FS_TOKEN}" }
      }]
    });
    expect(parsed.mcpServers[0]?.env?.API_TOKEN).toBe("${env:FS_TOKEN}");
    expect([...hostIds()]).toEqual([...HOST_IDS]);
    expect([...adapterKinds]).toEqual([...ARTIFACT_KINDS]);
  });

  it("keeps the committed toolkit schema equal to the zod export", async () => {
    const file = path.resolve(import.meta.dirname, "../../../resources/toolkit/toolkit.schema.json");
    const committed = JSON.parse(await readFile(file, "utf8")) as unknown;
    expect(committed).toEqual(toolkitJsonSchema());
  });
});
