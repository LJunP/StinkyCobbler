/** Holistic validation for the four effective tiered policy files. */

import type { EffectiveTemplatesConfig, OrchestrationConfig } from "./tiered.js";
import { loadOrchestrationConfig, loadTemplatesConfig } from "./tiered.js";
import type { WorkerProfile } from "../contracts/orchestration.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { assertWorkspacePathPolicy } from "../security/workspace-path.js";
import type { ContractTemplate } from "../storage/contract-templates.js";
import { listContractTemplates } from "../storage/contract-templates.js";
import { listSpecialists } from "../storage/specialists.js";
import type { LocalWorkspace } from "../storage/workspace.js";

export interface EffectiveTieredConfiguration {
  orchestration: OrchestrationConfig;
  specialists: WorkerProfile[];
  guidanceTemplates: EffectiveTemplatesConfig;
  contractTemplates: ContractTemplate[];
}

/**
 * Loads all four policy files and validates cross-file compatibility. A file
 * is not "healthy" when its shape is valid but its effective entries can
 * never pass the configured orchestration limits or sensitive-path policy.
 */
export async function loadAndValidateAllTieredConfig(workspace: LocalWorkspace): Promise<EffectiveTieredConfiguration> {
  const orchestration = await loadOrchestrationConfig(workspace);
  const specialists = await listSpecialists(workspace);
  const guidanceTemplates = await loadTemplatesConfig(workspace);
  const contractTemplates = await listContractTemplates(workspace);

  const maxDomainLength = orchestration.defaults?.maxDomainLength ?? 64;
  const maxDomainInstructions = orchestration.defaults?.maxDomainInstructions ?? 30;
  for (const profile of specialists) {
    if (profile.domain.length > maxDomainLength) {
      throw crossFileError(`专才 ${profile.domain} 的 domain 长度超过 effective maxDomainLength ${maxDomainLength}。`);
    }
    const injectedCount = 1 + profile.instructions.length + profile.acceptanceChecklist.length + profile.negativeRules.length;
    if (injectedCount > maxDomainInstructions) {
      throw crossFileError(`专才 ${profile.domain} 实际注入 ${injectedCount} 条 domainInstructions，超过 effective maxDomainInstructions ${maxDomainInstructions}。`);
    }
  }

  const maxContractCriteria = orchestration.defaults?.maxContractCriteria ?? 20;
  const maxContractScope = orchestration.defaults?.maxContractScopeItems ?? 50;
  for (const template of contractTemplates) {
    if (template.domain.length > maxDomainLength) {
      throw crossFileError(`契约模板 ${template.name} 的 domain 长度超过 effective maxDomainLength ${maxDomainLength}。`);
    }
    if (template.criteria.length > maxContractCriteria) {
      throw crossFileError(`契约模板 ${template.name} 含 ${template.criteria.length} 条 criteria，超过 effective maxContractCriteria ${maxContractCriteria}。`);
    }
    if (template.scope.length > maxContractScope) {
      throw crossFileError(`契约模板 ${template.name} 含 ${template.scope.length} 条 scope，超过 effective maxContractScopeItems ${maxContractScope}。`);
    }
    for (const scope of template.scope) {
      try {
        assertWorkspacePathPolicy(scope, {
          ...(orchestration.sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths: orchestration.sensitiveExtraPaths })
        });
      } catch {
        throw crossFileError(`契约模板 ${template.name} 的 scope 与 effective 敏感/保留路径策略冲突。`);
      }
    }
  }

  return { orchestration, specialists, guidanceTemplates, contractTemplates };
}

function crossFileError(message: string): StinkyCobblerError {
  return new StinkyCobblerError("TIERED_CONFIG_INVALID", ExitCode.VALIDATION, `四文件 effective 配置不兼容：${message}`, {
    fix: "修复：调整 orchestration.yaml 的收紧上限/敏感路径，或修改对应 specialists.yaml / contract-templates.yaml 条目，然后重新运行 doctor --root。"
  });
}
