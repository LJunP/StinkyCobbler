import { describe, expect, it } from "vitest";
import { removeSegment, upsertSegment } from "../../src/io/segment-file.js";

const begin = "<!-- stinky-cobbler:begin notes -->";
const end = "<!-- stinky-cobbler:end notes -->";

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
});
