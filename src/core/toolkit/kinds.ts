/** Artifact kinds shared by host adapters and the toolkit spec. */
export const ARTIFACT_KINDS = ["skill", "mcp-server", "instructions", "command"] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Host ids in `hostAdapters` order.
 * Core cannot import `src/hosts` (STANDARDS C2, enforced by dependency-cruiser core-has-no-io), so the
 * equality is locked by `test/core/toolkit/spec.test.ts`.
 */
export const HOST_IDS = ["zcode", "codex", "claude-code", "cursor"] as const;

export type ToolkitHostId = (typeof HOST_IDS)[number];

export const TRANSPORTS = ["stdio", "http"] as const;

export type Transport = (typeof TRANSPORTS)[number];
