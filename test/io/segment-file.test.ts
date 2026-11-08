import { describe, expect, it } from "vitest";
import { readSegments, removeSegment, upsertSegment } from "../../src/io/segment-file.js";

const begin = "<!-- stinky-cobbler:begin notes -->";
const end = "<!-- stinky-cobbler:end notes -->";
const SegmentMarkerError = /cannot contain a segment marker/;

describe("segment file", () => {
  it("replaces only the marked segment", () => {
    const source = `before\n\n${begin}\nold\n${end}\nafter\n`;
    const next = upsertSegment(source, "notes", "new body\n");
    expect(next).toBe(`before\n\n${begin}\nnew body\n${end}\nafter\n`);
  });

  it("removes a segment without changing the surrounding bytes", () => {
    const source = `before\n\n${begin}\nold\n${end}\nafter\n`;
    expect(removeSegment(source, "notes")).toBe("before\n\n\nafter\n");
  });

  it("rejects a segment id that could change the marker syntax", () => {
    expect(() => upsertSegment("before\n", "notes -->", "x")).toThrow(/Segment id/);
  });

  it("reads every segment body as upsertSegment stores it", () => {
    const source = `user text\n${begin}\nold\n${end}\n<!-- stinky-cobbler:begin style -->\nshort\n<!-- stinky-cobbler:end style -->\n`;
    expect(readSegments(source)).toEqual({ notes: "old\n", style: "short\n" });
    expect(readSegments("no markers here\n")).toEqual({});
  });

  it("reads only top-level paired segments, so a marker quoted in a body or left unpaired does not break observation", () => {
    const quoted = "<!-- stinky-cobbler:begin example -->";
    const source = `${begin}\nwrite ${quoted} to start a block\n${end}\n<!-- stinky-cobbler:begin orphan -->\nno end\n`;
    expect(readSegments(source)).toEqual({ notes: `write ${quoted} to start a block\n` });
    expect(() => upsertSegment(source, "orphan", "x")).toThrow(/no matching end marker/);
  });

  it("replaces the real segment, not a marker for the same id quoted inside another segment's body", () => {
    const style = (body: string): string => `<!-- stinky-cobbler:begin style -->\n${body}<!-- stinky-cobbler:end style -->`;
    const notes = `${begin}\nquote: <!-- stinky-cobbler:begin style --> starts a block\n${end}`;
    const source = `${notes}\n${style("old\n")}\n`;
    expect(upsertSegment(source, "style", "new\n")).toBe(`${notes}\n${style("new\n")}\n`);
    expect(removeSegment(source, "style")).toBe(`${notes}\n\n`);
  });

  it("does not report inherited object keys as segments", () => {
    expect(Object.hasOwn(readSegments("<!-- stinky-cobbler:begin constructor -->\nbody\n<!-- stinky-cobbler:end constructor -->\n"), "constructor")).toBe(true);
    expect(Object.hasOwn(readSegments("plain\n"), "constructor")).toBe(false);
  });

  it("refuses a body that contains any segment marker, since it would corrupt later reads", () => {
    expect(() => upsertSegment("", "notes", "see <!-- stinky-cobbler:begin other --> here\n")).toThrow(SegmentMarkerError);
    expect(() => upsertSegment("", "notes", "<!-- stinky-cobbler:end other -->\n")).toThrow(SegmentMarkerError);
  });
});
