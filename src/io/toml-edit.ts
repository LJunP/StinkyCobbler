import { stringify } from "smol-toml";

/**
 * Appends one TOML fragment. smol-toml stringify drops comments, so the
 * existing document stays a byte prefix and only the new tables are rendered.
 * A missing final newline is added before the fragment.
 */
export function appendTomlDocument(source: string, fragment: Record<string, unknown>): string {
  const rendered = stringify(fragment);
  const block = rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  if (source.length === 0) return block;
  const base = source.endsWith("\n") ? source : `${source}\n`;
  const gap = base.endsWith("\n\n") ? "" : "\n";
  return `${base}${gap}${block}`;
}
