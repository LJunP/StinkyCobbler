/** Contract templates: prebuilt goal/criteria/scope/domain bundles for one-command contract creation. */

import { loadContractTemplatesPolicy } from "../../config/tiered.js";
import { ExitCode, StinkyCobblerError } from "../../errors.js";
import type { LocalWorkspace } from "./workspace.js";

export interface ContractTemplate {
  name: string;
  description: string;
  domain: string;
  goal: string;
  criteria: string[];
  scope: string[];
}

/** Loads builtin, XDG user, and workspace templates. The same name replaces; a new name appends. */
export async function listContractTemplates(workspace: LocalWorkspace | null): Promise<ContractTemplate[]> {
  const { effective } = await loadContractTemplatesPolicy(workspace);
  return effective.templates ?? [];
}

export async function getContractTemplate(workspace: LocalWorkspace | null, name: string): Promise<ContractTemplate> {
  const template = (await listContractTemplates(workspace)).find((candidate) => candidate.name === name);
  if (!template) throw new StinkyCobblerError("CONTRACT_TEMPLATE_NOT_FOUND", ExitCode.VALIDATION, `Contract template "${name}" does not exist.`);
  return template;
}
