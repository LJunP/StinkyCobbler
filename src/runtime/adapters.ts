import type { AdapterDescriptor } from "../contracts/types.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { runScriptedReadonly, type ReadonlyRunResult, type ScriptedReadonlyInput } from "./scripted-readonly.js";

export interface TrustedRuntimeAdapter {
  readonly descriptor: AdapterDescriptor;
  executeReadonly(input: ScriptedReadonlyInput): Promise<ReadonlyRunResult>;
}

export interface AdapterRegistry {
  descriptors: readonly AdapterDescriptor[];
  resolve(id: string): TrustedRuntimeAdapter;
}

export function createAdapterRegistry(): AdapterRegistry {
  const scriptedReadonly: TrustedRuntimeAdapter = {
    descriptor: {
      id: "scripted-readonly",
      status: "available",
      runtime: "builtin",
      implementationRef: "builtin.scripted-readonly",
      supports: ["repository-read", "repository-list"]
    },
    executeReadonly: runScriptedReadonly
  };
  const adapters = new Map<string, TrustedRuntimeAdapter>([[scriptedReadonly.descriptor.id, scriptedReadonly]]);
  return {
    descriptors: [...adapters.values()].map((adapter) => adapter.descriptor),
    resolve(id: string): TrustedRuntimeAdapter {
      const adapter = adapters.get(id);
      if (!adapter) throw new StinkyCobblerError("RUNTIME_EXECUTOR_UNAVAILABLE", ExitCode.VALIDATION, "The requested Runtime adapter is not available.", { executor: id });
      return adapter;
    }
  };
}
