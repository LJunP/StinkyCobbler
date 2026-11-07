/** Specialist worker registry: domain profiles injected into subtask packages (2.0 domain routing). */

import { loadSpecialistsPolicy } from "../config/tiered.js";
import { GENERAL_DOMAIN } from "../contracts/orchestration.js";
import type { WorkerProfile } from "../contracts/orchestration.js";
import { ExitCode, StinkyCobblerError } from "../../errors.js";
import type { LocalWorkspace } from "./workspace.js";

/**
 * Loads the merged specialist registry: builtin, then the XDG user layer, then
 * the workspace overlay. An existing domain is replaced. A new domain is appended.
 * The "general" fallback stays unless a later layer replaces that same domain.
 */
export async function loadSpecialistRegistry(workspace: LocalWorkspace | null): Promise<WorkerProfile[]> {
  const { effective } = await loadSpecialistsPolicy(workspace);
  const profiles = effective.specialists ?? [];
  if (!profiles.some((profile) => profile.domain === GENERAL_DOMAIN)) {
    throw new StinkyCobblerError("SPECIALIST_REGISTRY_EMPTY", ExitCode.INTERNAL, "Specialist registry has no general fallback profile.");
  }
  return profiles;
}

export type SpecialistMatch = "exact" | "prefix" | "general";

/** Resolves a domain to its specialist profile: exact → prefix ("frontend/forms" → "frontend") → general fallback. */
export async function resolveSpecialist(workspace: LocalWorkspace | null, domain: string): Promise<{ profile: WorkerProfile; match: SpecialistMatch }> {
  const profiles = await loadSpecialistRegistry(workspace);
  const exact = profiles.find((p) => p.domain === domain);
  if (exact) return { profile: exact, match: "exact" };
  const prefix = profiles.find((p) => domain.startsWith(`${p.domain}/`));
  if (prefix) return { profile: prefix, match: "prefix" };
  const general = profiles.find((p) => p.domain === GENERAL_DOMAIN);
  if (!general) throw new StinkyCobblerError("SPECIALIST_REGISTRY_EMPTY", ExitCode.INTERNAL, "Specialist registry has no general fallback profile.");
  return { profile: general, match: "general" };
}

/** Builds the domain instruction list injected into a subtask package (worker follows ONLY this). */
export async function domainInstructionsFor(workspace: LocalWorkspace | null, domain: string): Promise<string[]> {
  const { profile } = await resolveSpecialist(workspace, domain);
  return [
    `[专才] ${profile.title}（领域 ${domain}）`,
    ...profile.instructions,
    ...profile.acceptanceChecklist.map((item) => `验收：${item}`),
    ...profile.negativeRules.map((item) => `禁止：${item}`)
  ];
}

export async function listSpecialists(workspace: LocalWorkspace | null): Promise<WorkerProfile[]> {
  return loadSpecialistRegistry(workspace);
}

export async function getSpecialist(workspace: LocalWorkspace | null, domain: string): Promise<{ profile: WorkerProfile; match: SpecialistMatch }> {
  return resolveSpecialist(workspace, domain);
}
