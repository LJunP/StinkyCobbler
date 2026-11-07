#!/usr/bin/env node
/**
 * Type-check src/ and test/ together (tsconfig.test.json) and enforce a
 * ratchet: the number of errors under test/ may only go down. The baseline
 * lives in test/repo/typecheck-baseline.json; lower it in the same change that
 * fixes errors, never raise it.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(projectRoot, "test", "repo", "typecheck-baseline.json");
const tscBin = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");

async function runTsc() {
  try {
    const { stdout } = await execFileAsync(process.execPath, [tscBin, "-p", "tsconfig.test.json", "--pretty", "false"], { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (typeof error?.stdout === "string") return error.stdout;
    throw error;
  }
}

const output = await runTsc();
const lines = output.split(/\r?\n/).filter((line) => /error TS\d+/.test(line));
const srcErrors = lines.filter((line) => !line.startsWith("test/"));
const testErrors = lines.filter((line) => line.startsWith("test/"));
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));

if (srcErrors.length > 0) {
  process.stderr.write(`${srcErrors.join("\n")}\n`);
  process.stderr.write(`check-test-types: ${srcErrors.length} error(s) outside test/ (src must be clean)\n`);
  process.exit(1);
}

if (process.argv.includes("--update-baseline")) {
  await writeFile(baselinePath, `${JSON.stringify({ testErrors: testErrors.length }, null, 2)}\n`);
  process.stdout.write(`check-test-types: baseline set to ${testErrors.length}\n`);
  process.exit(0);
}

if (testErrors.length > baseline.testErrors) {
  process.stderr.write(`${testErrors.join("\n")}\n`);
  process.stderr.write(`check-test-types: ${testErrors.length} test type error(s) exceeds baseline ${baseline.testErrors}\n`);
  process.exit(1);
}

if (testErrors.length < baseline.testErrors) {
  process.stderr.write(`check-test-types: ${testErrors.length} < baseline ${baseline.testErrors}; run with --update-baseline to ratchet down\n`);
  process.exit(1);
}

process.stdout.write(`check-test-types: ok (${testErrors.length} known test type errors, baseline ${baseline.testErrors})\n`);
