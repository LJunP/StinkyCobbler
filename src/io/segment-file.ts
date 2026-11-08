import { ExitCode, StinkyCobblerError } from "../errors.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BEGIN_PATTERN = /<!-- stinky-cobbler:begin ([^\s]+) -->/g;
const ANY_MARKER_PATTERN = /<!-- stinky-cobbler:(?:begin|end) [^\s]+ -->/;

/** Replaces one marked segment. Bytes outside the begin/end pair stay identical. */
export function upsertSegment(source: string, id: string, body: string): string {
  assertSegmentId(id);
  const block = segmentBlock(id, body);
  const located = locateSegment(source, id);
  if (located === undefined) return appendBlock(source, block);
  return `${source.slice(0, located.start)}${block}${source.slice(located.end)}`;
}

/** Returns the bytes inside one marked segment. Does not search the body. */
export function readSegment(source: string, id: string): string {
  assertSegmentId(id);
  const located = locateSegment(source, id);
  if (located === undefined) throw segmentError("Managed segment was not found.");
  const begin = beginMarker(id);
  const end = endMarker(id);
  let from = located.start + begin.length;
  if (source[from] === "\n") from += 1;
  return source.slice(from, located.end - end.length);
}

/**
 * Returns the body of every top-level, paired segment, keyed by id. A begin marker quoted inside
 * another segment's body, or one without its end marker, is not a segment and is left out; writing
 * an unpaired id later still fails in `upsertSegment`, so a broken file is refused when it would be changed.
 */
export function readSegments(source: string): Record<string, string> {
  const bodies: Record<string, string> = {};
  for (const [id, located] of scanSegments(source).paired) {
    let from = located.start + beginMarker(id).length;
    if (source[from] === "\n") from += 1;
    bodies[id] = source.slice(from, located.end - endMarker(id).length);
  }
  return bodies;
}

/** Removes one marked segment. Bytes outside the pair stay identical. */
export function removeSegment(source: string, id: string): string {
  assertSegmentId(id);
  const located = locateSegment(source, id);
  if (located === undefined) return source;
  return `${source.slice(0, located.start)}${source.slice(located.end)}`;
}

function segmentBlock(id: string, body: string): string {
  const begin = beginMarker(id);
  const end = endMarker(id);
  if (ANY_MARKER_PATTERN.test(body)) {
    throw segmentError("Segment body cannot contain a segment marker; a quoted marker would split the file on the next read.");
  }
  const text = body.endsWith("\n") ? body : `${body}\n`;
  return `${begin}\n${text}${end}`;
}

/** Reads, upserts and removals all use the same top-level scan, so a quoted marker is never mistaken for a segment. */
function locateSegment(source: string, id: string): { start: number; end: number } | undefined {
  const scanned = scanSegments(source);
  const located = scanned.paired.get(id);
  if (located !== undefined) return located;
  if (scanned.unpaired.has(id)) throw segmentError("Managed segment begin marker has no matching end marker.");
  return undefined;
}

function scanSegments(source: string): { paired: Map<string, { start: number; end: number }>; unpaired: Set<string> } {
  const paired = new Map<string, { start: number; end: number }>();
  const unpaired = new Set<string>();
  let cursor = 0;
  for (const match of source.matchAll(BEGIN_PATTERN)) {
    const id = match[1];
    if (match.index < cursor || id === undefined || !ID_PATTERN.test(id) || paired.has(id)) continue;
    const endAt = source.indexOf(endMarker(id), match.index + match[0].length);
    if (endAt < 0) {
      unpaired.add(id);
      continue;
    }
    paired.set(id, { start: match.index, end: endAt + endMarker(id).length });
    cursor = endAt + endMarker(id).length;
  }
  return { paired, unpaired };
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
