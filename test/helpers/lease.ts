import type { CapabilityLease } from "../../src/gate/contracts/types.js";

/**
 * Marks a 2.0-shaped lease literal (no parentGrantRef / taskAuthorityHash /
 * hostSessionId) as a CapabilityLease for tests of pure evaluators and read
 * tools, which never consult those authority fields. Persisted-authority paths
 * reject this shape; see legacy-authority-compat.test.ts.
 */
export function asLegacyLease(value: object): CapabilityLease {
  return value as unknown as CapabilityLease;
}
