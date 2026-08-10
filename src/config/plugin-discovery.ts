import type { PluginDiagnostic, PluginManifest } from "../contracts/types.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";

const TRUSTED_IMPLEMENTATIONS = new Set(["builtin.repository-read", "builtin.git-read", "builtin.docs-index"]);

export interface PluginDiscoveryResult {
  plugins: Map<string, PluginManifest>;
  diagnostics: Map<string, PluginDiagnostic>;
}

export function discoverBuiltinPlugins(manifests: PluginManifest[]): PluginDiscoveryResult {
  const plugins = new Map<string, PluginManifest>();
  const operations = new Map<string, string>();
  for (const plugin of [...manifests].sort((left, right) => left.id.localeCompare(right.id))) {
    if (plugins.has(plugin.id)) throw discoveryError("PLUGIN_DUPLICATE_ID", "Plugin IDs must be unique.", { id: plugin.id });
    for (const operation of plugin.operations) {
      const owner = operations.get(operation);
      if (owner) throw discoveryError("PLUGIN_DUPLICATE_OPERATION", "Plugin operations must be unique.", { operation, firstPlugin: owner, secondPlugin: plugin.id });
      operations.set(operation, plugin.id);
    }
    plugins.set(plugin.id, plugin);
  }

  const checkedAt = new Date().toISOString();
  const diagnostics = new Map<string, PluginDiagnostic>();
  for (const plugin of plugins.values()) {
    const implementationAvailable = plugin.implementationRef !== undefined && TRUSTED_IMPLEMENTATIONS.has(plugin.implementationRef);
    const executable = implementationAvailable && plugin.status === "available" && plugin.runtime !== "unavailable";
    const diagnostic: PluginDiagnostic = {
      id: plugin.id,
      status: executable ? plugin.status : plugin.status === "available" ? "unavailable" : plugin.status,
      level: plugin.level,
      operations: [...plugin.operations],
      source: plugin.source,
      implementationAvailable,
      executable,
      checkedAt,
      ...(executable ? {} : { reasonCode: plugin.status === "declared-only" ? "PLUGIN_DECLARED_ONLY" : "PLUGIN_IMPLEMENTATION_UNAVAILABLE", reason: plugin.status === "declared-only" ? "Manifest is descriptive only; no executable capability is enabled." : "No trusted built-in implementation is bound." })
    };
    diagnostics.set(plugin.id, diagnostic);
  }
  return { plugins, diagnostics };
}

function discoveryError(code: string, message: string, details: Record<string, unknown>): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details);
}
