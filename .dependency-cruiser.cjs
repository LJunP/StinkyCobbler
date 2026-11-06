/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "STANDARDS C2: no import cycles. Known 2.x kernel cycles are listed in .dependency-cruiser-known-violations.json and may only shrink.",
      from: {},
      to: { circular: true }
    },
    {
      name: "no-dynamic-import-to-break-cycles",
      severity: "error",
      comment: "STANDARDS C2: dynamic import() must not be used to hide a cycle.",
      from: {},
      to: { dynamic: true, circular: true }
    },
    {
      name: "core-has-no-io",
      severity: "error",
      comment: "STANDARDS C2 and C9: src/core never touches the file system or hosts/app/io.",
      from: { path: "^src/core/" },
      to: { path: "^(node:fs|fs|node:fs/promises|src/(hosts|app|io)/)" }
    },
    {
      name: "gate-is-only-reached-from-cli",
      severity: "error",
      comment: "ADR-0002: keep this exemption until config, entry, security, contracts, cli.ts, and mcp-server.ts no longer import src/gate. app stays allowed as the command layer. Do not drop those pathNot prefixes while the imports remain.",
      from: { pathNot: "^src/(gate/|cli\\.ts$|mcp-server\\.ts$|config/|entry/|security/|contracts/|app/)" },
      to: { path: "^src/gate/" }
    }
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"], extensions: [".ts", ".js", ".mjs"] },
    reporterOptions: { text: { highlightFocused: true } }
  }
};
