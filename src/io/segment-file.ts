import { readFile } from "node:fs/promises";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { atomicWrite, readRegularHostFile } from "./managed-file.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Replaces one marked segment. Bytes outside the begin/end pair stay identical. */
export function upsertSegment(source: string, id: string, body: string): string {
  assertSegmentId(id);
  const block = segmentBlock(id, body);
  const located = locateSegment(source, id);
  if (located === undefined) return appendBlock(source, block);
  return `${source.slice(0, located.start)}${block}${source.slice(located.end)}`;
}

/** Removes one marked segment. Bytes outside the pair stay identical. */
export function removeSegment(source: string, id: string): string {
  assertSegmentId(id);
  const located = locateSegment(source, id);
  if (located === undefined) return source;
  return `${source.slice(0, located.start)}${source.slice(located.end)}`;
}

export async function upsertSegmentFile(target: string, id: string, body: string): Promise<void> {
  const existing = await readRegularHostFile(target);
  await atomicWrite(target, upsertSegment(existing ?? "", id, body));
}

export async function removeSegmentFile(target: string, id: string): Promise<void> {
  const existing = await readFile(target, "utf8");
  await atomicWrite(target, removeSegment(existing, id));
}

function segmentBlock(id: string, body: string): string {
  const begin = beginMarker(id);
  const end = endMarker(id);
  if (body.includes(begin) || body.includes(end)) {
    throw segmentError("Segment body cannot contain its own markers.");
  }
  const text = body.endsWith("\n") ? body : `${body}\n`;
  return `${begin}\n${text}${end}`;
}

function locateSegment(source: string, id: string): { start: number; end: number } | undefined {
  const begin = beginMarker(id);
  const start = source.indexOf(begin);
  if (start < 0) return undefined;
  const endMarkerText = endMarker(id);
  const endAt = source.indexOf(endMarkerText, start + begin.length);
  if (endAt < 0) throw segmentError("Managed segment begin marker has no matching end marker.");
  return { start, end: endAt + endMarkerText.length };
}

function appendBlock(source: string, block: string): string {
  if (source.length === 0) return `${block}\n`;
  const base = source.endsWith("\n") ? source : `${source}\n`;
  const gap = base.endsWith("\n\n") ? "" : "\n";
  return `${base}${gap}${block}\n`;
}

function beginMarker(id: string): string {
  return `<!-- stinky-cobbler:begin ${id} -->`;
}

function endMarker(id: string): string {
  return `<!-- stinky-cobbler:end ${id} -->`;
}

function assertSegmentId(id: string): void {
  if (!ID_PATTERN.test(id)) throw segmentError("Segment id must be a short token.");
}

function segmentError(message: string): StinkyCobblerError {
  return new StinkyCobblerError("SEGMENT_INVALID", ExitCode.VALIDATION, message);
}
