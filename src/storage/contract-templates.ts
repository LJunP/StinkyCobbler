/** Contract templates: prebuilt goal/criteria/scope/domain bundles for one-command contract creation. */

import type { ContractTemplatesFile } from "../config/tiered.js";
import { loadTieredYaml } from "../config/tiered.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import type { LocalWorkspace } from "./workspace.js";

export interface ContractTemplate {
  name: string;
  description: string;
  domain: string;
  goal: string;
  criteria: string[];
  scope: string[];
}

/** Loads the merged template library: builtin + workspace overlay (same name replaces, new name appends). */
export async function listContractTemplates(workspace: LocalWorkspace | null): Promise<ContractTemplate[]> {
  const { builtin, user } = await loadTieredYaml<ContractTemplatesFile>(workspace, "contract-templates.yaml", 1);
  const byName = new Map<string, ContractTemplate>();
  for (const template of builtin.templates) byName.set(template.name, template);
  for (const template of user?.templates ?? []) byName.set(template.name, template);
  return [...byName.values()];
}

export async function getContractTemplate(workspace: LocalWorkspace | null, name: string): Promise<ContractTemplate> {
  const template = (await listContractTemplates(workspace)).find((candidate) => candidate.name === name);
  if (!template) throw new StinkyCobblerError("CONTRACT_TEMPLATE_NOT_FOUND", ExitCode.VALIDATION, `Contract template "${name}" does not exist.`);
  return template;
}
