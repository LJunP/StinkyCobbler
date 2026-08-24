import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, unzipSync, zipSync } from "fflate";

const ZIP_EPOCH = new Date("1980-06-01T00:00:00.000Z");

/** True only when an ES module is the file Node was asked to execute. */
export function isDirectInvocation(metaUrl, argv1 = process.argv[1]) {
  if (argv1 === undefined) return false;
  try {
    const current = path.resolve(fileURLToPath(metaUrl));
    const invoked = path.resolve(argv1);
    return process.platform === "win32" ? current.toLowerCase() === invoked.toLowerCase() : current === invoked;
  } catch {
    return false;
  }
}

/** Execute npm and npm-generated command shims on every supported Node platform. */
export function execPortableSync(command, args, options = {}) {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    return execFileSync(command, args, { ...options, shell: process.env.ComSpec ?? true });
  }
  return execFileSync(command, args, options);
}

export function npmExecutable() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/** Correct cmd.exe /S /C double quoting for one trusted .cmd path plus fixed safe arguments. */
export function windowsCmdInvocation(script, args = []) {
  if (typeof script !== "string" || script === "" || /["\r\n&|<>^%!]/.test(script)) {
    throw new Error("Windows launcher path contains unsupported command-shell characters.");
  }
  if (!args.every((argument) => typeof argument === "string" && /^[A-Za-z0-9._-]*$/.test(argument))) {
    throw new Error("Windows launcher arguments must use the fixed safe argument alphabet.");
  }
  const suffix = args.length === 0 ? "" : ` ${args.join(" ")}`;
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `""${script}"${suffix}"`]
  };
}

/** Create a ZIP with one explicit top-level directory and portable Unix modes. */
export async function createZipFromDirectory(source, out, topLevelName) {
  const files = {};
  async function visit(directory, prefix) {
    const names = (await readdir(directory)).sort();
    if (names.length === 0) {
      files[`${topLevelName}/${prefix}`.replace(/\/$/, "") + "/"] = [new Uint8Array(), {
        os: 3,
        attrs: 0o40755 << 16,
        mtime: ZIP_EPOCH
      }];
      return;
    }
    for (const name of names) {
      const absolute = path.join(directory, name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Archive input must not contain symbolic links: ${path.join(prefix, name)}`);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      if (info.isDirectory()) {
        await visit(absolute, relative);
      } else if (info.isFile()) {
        files[`${topLevelName}/${relative}`] = [new Uint8Array(await readFile(absolute)), {
          level: 9,
          os: 3,
          attrs: ((info.mode & 0o777) | 0o100000) << 16,
          mtime: ZIP_EPOCH
        }];
      } else {
        throw new Error(`Archive input must contain only regular files and directories: ${relative}`);
      }
    }
  }
  await visit(source, "");
  await writeFile(out, zipSync(files, { level: 9 }));
}

/** Extract a ZIP as regular files only; path traversal and link-like entries fail closed. */
export async function extractZipSafe(file, out) {
  const entries = unzipSync(new Uint8Array(await readFile(file)));
  for (const [entryName, bytes] of Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))) {
    const isDirectory = entryName.endsWith("/");
    const relative = safeArchivePath(entryName, isDirectory);
    const target = path.join(out, ...relative.split("/"));
    if (isDirectory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: 0o644 });
  }
}

/** Extract the regular-file subset used by npm pack tarballs without a system tar binary. */
export async function extractNpmTarballSafe(file, out) {
  const tar = gunzipSync(new Uint8Array(await readFile(file)));
  let offset = 0;
  let nextPath;
  let nextPax = {};
  let globalPax = {};
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    assertTarChecksum(header);
    const size = tarNumber(header.subarray(124, 136));
    const mode = tarNumber(header.subarray(100, 108));
    const type = String.fromCharCode(header[156] ?? 0);
    const rawName = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const headerPath = prefix === "" ? rawName : `${prefix}/${rawName}`;
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.byteLength) throw new Error("Invalid npm tarball entry size.");
    const body = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (type === "x" || type === "g") {
      const parsed = parsePax(body);
      if (type === "g") globalPax = { ...globalPax, ...parsed };
      else nextPax = parsed;
      continue;
    }
    if (type === "L") {
      nextPath = tarString(body);
      continue;
    }
    const effectivePath = nextPath ?? nextPax.path ?? globalPax.path ?? headerPath;
    nextPath = undefined;
    nextPax = {};
    const isDirectory = type === "5" || effectivePath.endsWith("/");
    const relative = safeArchivePath(effectivePath, isDirectory);
    const target = path.join(out, ...relative.split("/"));
    if (isDirectory) {
      await mkdir(target, { recursive: true });
    } else if (type === "\0" || type === "0" || type === "7") {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body, { flag: "wx", mode: mode & 0o777 });
    } else {
      throw new Error(`npm tarball contains an unsupported linked or special entry: ${effectivePath}`);
    }
  }
}

/** Exact file tree fingerprint; links and special files are rejected. */
export async function directoryFingerprint(rootDirectory, options = {}) {
  const entries = [];
  async function walk(directory, prefix) {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${relative}`);
      if (info.isDirectory()) {
        entries.push(["directory", relative]);
        await walk(absolute, relative);
      } else if (info.isFile()) {
        entries.push(options.includeExecutable === false
          ? ["file", relative, info.size, await sha256File(absolute)]
          : ["file", relative, info.mode & 0o111, info.size, await sha256File(absolute)]);
      } else {
        throw new Error(`special files are not allowed: ${relative}`);
      }
    }
  }
  await walk(rootDirectory, "");
  return entries;
}

export async function removeNonRuntimeBin(nodeModules) {
  await rm(path.join(nodeModules, ".bin"), { recursive: true, force: true });
}

export function safeArchivePath(value, isDirectory = false) {
  if (typeof value !== "string" || value === "" || value.includes("\0") || value.includes("\\") || value.includes(":")) {
    throw new Error(`Archive contains an invalid path: ${String(value)}`);
  }
  const withoutSlash = isDirectory ? value.replace(/\/+$/, "") : value;
  const normalized = path.posix.normalize(withoutSlash);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/") || normalized !== withoutSlash) {
    throw new Error(`Archive path escapes or is non-canonical: ${value}`);
  }
  return normalized;
}

function tarString(bytes) {
  const zero = bytes.indexOf(0);
  return Buffer.from(zero < 0 ? bytes : bytes.subarray(0, zero)).toString("utf8").trimEnd();
}

function tarNumber(bytes) {
  if ((bytes[0] & 0x80) !== 0) {
    let value = BigInt(bytes[0] & 0x7f);
    for (const byte of bytes.subarray(1)) value = (value << 8n) | BigInt(byte);
    return Number(value);
  }
  const value = tarString(bytes).trim();
  return value === "" ? 0 : Number.parseInt(value, 8);
}

function assertTarChecksum(header) {
  const expected = tarNumber(header.subarray(148, 156));
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) actual += index >= 148 && index < 156 ? 32 : header[index];
  if (actual !== expected) throw new Error("npm tarball header checksum is invalid.");
}

function parsePax(bytes) {
  const result = {};
  let offset = 0;
  while (offset < bytes.byteLength) {
    let space = offset;
    while (space < bytes.byteLength && bytes[space] !== 32) space += 1;
    const length = Number.parseInt(Buffer.from(bytes.subarray(offset, space)).toString("ascii"), 10);
    if (space >= bytes.byteLength || !Number.isSafeInteger(length) || length <= 0 || offset + length > bytes.byteLength) throw new Error("Invalid PAX header.");
    const record = Buffer.from(bytes.subarray(space + 1, offset + length - 1)).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

async function sha256File(file) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(await readFile(file)).digest("hex");
}
