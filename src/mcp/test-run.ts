import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { authorize, denied, type ToolAccess, type ToolOutcome } from "./shared.js";
import { containsShellMetacharacter } from "../policy/path-policy.js";

const execFileAsync = promisify(execFile);
const ALLOWED_TEST_COMMANDS = {
  vitest: ["vitest", "run"],
  npmTest: ["test", "--"],
  nodeTest: ["--test"]
} as const;

export type TestCommand = keyof typeof ALLOWED_TEST_COMMANDS;
export interface TestRunRequest { command: TestCommand; args?: string[]; timeoutMs?: number; }

export async function runTests(access: ToolAccess, request: TestRunRequest): Promise<ToolOutcome<{ executable: string; argv: string[]; stdout: string; stderr: string; exitCode: number }>> {
  const decision = authorize(access, "test-run");
  if (!decision.allowed) return denied(decision);
  const fixedArgv = ALLOWED_TEST_COMMANDS[request.command];
  if (!fixedArgv) throw new Error("Unsupported test command.");
  const args = request.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || !arg || arg.includes("\0") || containsShellMetacharacter(arg))) {
    throw new Error("Test arguments must be plain argv values without shell metacharacters.");
  }
  const timeoutMs = request.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error("timeoutMs must be between 1000 and 120000.");

  const executable = request.command === "nodeTest" ? process.execPath : "npm";
  const argv = request.command === "nodeTest" ? [...fixedArgv, ...args] : ["exec", "--", ...fixedArgv, ...args];
  try {
    const { stdout, stderr } = await execFileAsync(executable, argv, {
      cwd: access.workspace,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      shell: false
    });
    return { decision, data: { executable, argv, stdout, stderr, exitCode: 0 } };
  } catch (error: unknown) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    return {
      decision,
      data: {
        executable,
        argv,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: typeof result.code === "number" ? result.code : 1
      }
    };
  }
}
