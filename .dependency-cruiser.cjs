/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Rule A3: no import cycles. Known 2.x kernel cycles are listed in .dependency-cruiser-known-violations.json and may only shrink.",
      from: {},
      to: { circular: true }
    },
    {
      name: "no-dynamic-import-to-break-cycles",
      severity: "error",
      comment: "Rule A3: dynamic import() must not be used to hide a cycle.",
      from: {},
      to: { dynamic: true, circular: true }
    },
    {
      name: "core-has-no-io",
      severity: "error",
      comment: "Rule A9: src/core never touches the file system or hosts/app/io.",
      from: { path: "^src/core/" },
      to: { path: "^(node:fs|fs|node:fs/promises|src/(hosts|app|io)/)" }
    },
    {
      name: "gate-is-only-reached-from-cli",
      severity: "error",
      comment: "ADR-0002: the frozen 2.x kernel is referenced only by the entry points. M1-T1 temporary: config, entry, security and contracts still import the kernel until later M1 tasks remove those edges. Drop those four prefixes before the M1 exit check.",
      from: { pathNot: "^src/(gate/|cli\\.ts$|mcp-server\\.ts$|config/|entry/|security/|contracts/)" },
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
