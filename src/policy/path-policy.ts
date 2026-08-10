const SENSITIVE_NAME = /(^|[._-])(?:env|secret|secrets|token|tokens|credential|credentials|password|passwd|private|key|keys|auth|npmrc|netrc|keyring|envrc|pypirc)(?:$|[._-])/i;
const SENSITIVE_EXTENSION = /\.(?:tfstate|pypirc|npmrc|netrc|keyring|envrc)$/i;
const PRIVATE_KEY_NAME = /(?:^|[._-])(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|private[_-]?key)(?:$|[._-])/i;
const PRIVATE_KEY_EXTENSION = /\.(?:pem|p12|pfx|key|keystore)$/i;
/** File types that must never be written (executables and other binary/derived artifacts). */
const FORBIDDEN_WRITE_EXTENSION = /\.(?:pem|p12|pfx|key|keystore|exe|bin|dll|so|dylib|class|jar|war|o|obj|a|lib)$/i;
const SHELL_METACHARACTER = /[;&|`$<>\n\r\\]/;

/** Name- and type-level sensitive-path policy shared by read and write boundaries. */
export function isSensitivePath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => part === ".stinky-cobbler" || SENSITIVE_NAME.test(part) || SENSITIVE_EXTENSION.test(part) || PRIVATE_KEY_NAME.test(part) || PRIVATE_KEY_EXTENSION.test(part));
}

/** Write-only guard: executable and binary-derived targets are never writable. */
export function isForbiddenWriteTarget(path: string): boolean {
  return FORBIDDEN_WRITE_EXTENSION.test(path);
}

export function containsShellMetacharacter(value: string): boolean {
  return SHELL_METACHARACTER.test(value);
}
